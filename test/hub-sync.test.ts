import Fastify from 'fastify'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { createCard } from '../src/hub/cards.js'
import { hubSyncPlugin, streamOrgEvents } from '../src/hub/routes/sync.js'
import { HubBroadcaster } from '../src/hub/broadcast.js'
import type { HubEvent } from '../src/hub/types.js'
import type { HubSqlPool } from '../src/hub/sql.js'

afterEach(async () => { await closeHubServers() })

/** Pulls the `data:` lines out of an SSE body. */
function sseEvents(body: string): any[] {
  return body.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)))
}

/** Waits until `cond()` is true, polling briefly — for asserting on a live SSE stream. */
async function until(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition never became true')
}

/**
 * A bare Fastify app with only `hubSyncPlugin` registered — no auth, no ops route —
 * so a test can supply a `sql` whose `.query()` it fully controls (to hold a backlog
 * page's read open) without needing a real, timing-dependent multi-page drain against
 * PGlite.
 */
async function buildBareSyncApp(sql: HubSqlPool, broadcast: HubBroadcaster, backlogPageSize?: number) {
  const app = Fastify()
  app.decorateRequest('hubOrgId', null)
  app.addHook('onRequest', async (request) => { request.hubOrgId = 'org_a' })
  app.register(hubSyncPlugin, { sql, broadcast, prefix: '/api/v1/hub', backlogPageSize })
  await app.ready()
  return app
}

describe('hub sync stream', () => {
  it('replays the backlog from since= and closes when asked to catch up only', async () => {
    const hub = await hubFixture()
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'One' })
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'Two' })
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'Three' })

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=1&catchup=1`, headers: hub.auth(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = sseEvents(response.body)
    expect(events.map((e) => e.seq)).toEqual([2, 3])
    expect(events.every((e) => e.org_id === hub.orgId)).toBe(true)
  })

  it('replays nothing when the daemon is already current', async () => {
    const hub = await hubFixture()
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'One' })

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=1&catchup=1`, headers: hub.auth(),
    })
    expect(sseEvents(response.body)).toEqual([])
  })

  it('refuses a stream for another org', async () => {
    const hub = await hubFixture()
    const { mintDeviceToken } = await import('../src/hub/devices.js')
    const { seedOrg } = await import('./support/hub-sql.js')
    await seedOrg(hub.sql, 'org_b')
    const other = await mintDeviceToken(hub.sql, { orgId: 'org_b', name: 'intruder' })

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=0&catchup=1`,
      headers: hub.auth(other.token),
    })
    expect(response.statusCode).toBe(403)
  })

  it('rejects a non-numeric since before any header is written', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=banana&catchup=1`, headers: hub.auth(),
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects a negative since', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=-1&catchup=1`, headers: hub.auth(),
    })
    expect(response.statusCode).toBe(400)
  })

  it('streams a live event to an open connection and cleans up the subscriber on disconnect', async () => {
    const hub = await hubFixture()
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'One' })

    const controller = new AbortController()
    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=1`,
      headers: hub.auth(), payloadAsStream: true, signal: controller.signal,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(hub.broadcast.listenerCount(hub.orgId)).toBe(1)

    const chunks: string[] = []
    const stream = response.stream()
    stream.on('data', (c: Buffer) => chunks.push(c.toString('utf8')))
    stream.on('error', () => {}) // aborting destroys the stream; swallow the expected teardown error

    // Through the ops HTTP endpoint, not a direct `createCard` call — only the ops
    // route publishes to the broadcaster, so this is what actually exercises live
    // delivery over the open SSE connection.
    const created = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Two' } },
    })
    expect(created.statusCode).toBe(200)
    await until(() => sseEvents(chunks.join('')).some((e) => e.payload?.title === 'Two'))

    const delivered = sseEvents(chunks.join(''))
    expect(delivered).toHaveLength(1) // only the live event — since=1 already excludes the backlog card
    expect(delivered[0].org_id).toBe(hub.orgId)

    controller.abort()
    await until(() => hub.broadcast.listenerCount(hub.orgId) === 0)
  })

  it('cleans up the subscription and installs no ping when the client disconnects mid-drain', async () => {
    const broadcast = new HubBroadcaster()
    const row = (seq: number): HubEvent => ({
      id: `e${seq}`, org_id: 'org_a', seq, kind: 'card.created',
      board_id: null, actor_device_id: null, payload: {}, created_at: 'now',
    })

    let calls = 0
    let resolveSecondPage!: (rows: HubEvent[]) => void
    const sql = {
      query: vi.fn(async (_text: string, _params?: unknown[]) => {
        calls++
        if (calls === 1) return { rows: [row(1), row(2)], rowCount: 2 } // a full page (pageSize=2) — the drain asks for a second
        return new Promise((resolve) => {
          resolveSecondPage = (rows) => resolve({ rows, rowCount: rows.length })
        })
      }),
    } as unknown as HubSqlPool

    const app = await buildBareSyncApp(sql, broadcast, 2)
    const controller = new AbortController()

    const responsePromise = app.inject({
      method: 'GET', url: '/api/v1/hub/orgs/org_a/sync?since=0',
      payloadAsStream: true, signal: controller.signal,
    })

    // Wait for the first page to land and the second page's read to be in flight —
    // the drain is now genuinely stuck mid-backlog.
    await until(() => calls === 2)
    expect(broadcast.listenerCount('org_a')).toBe(1)

    // The client vanishes while that second read is still pending.
    controller.abort()
    await until(() => broadcast.listenerCount('org_a') === 0)

    // Let the stuck read resolve well after the disconnect. This must not resurrect
    // a ping or throw trying to write to a torn-down connection.
    resolveSecondPage([])
    await new Promise((r) => setImmediate(r))
    await responsePromise.catch(() => {}) // aborted — light-my-request rejects; that's expected

    await app.close()
  })

  it('publishes no second live event for a replayed idempotency key', async () => {
    const hub = await hubFixture()
    const seen: HubEvent[] = []
    const unsubscribe = hub.broadcast.subscribe(hub.orgId, (event) => seen.push(event))

    const op = {
      op: 'card.create', idempotency_key: 'sync-replay-1',
      payload: { board_id: hub.boardId, title: 'Once' },
    }
    const first = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(), payload: op,
    })
    const second = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(), payload: op,
    })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('card.created')

    unsubscribe()
  })
})

describe('hub broadcaster', () => {
  it('delivers a live event to the right org only', async () => {
    const { HubBroadcaster } = await import('../src/hub/broadcast.js')
    const broadcaster = new HubBroadcaster()
    const seenA: any[] = []
    const seenB: any[] = []

    const unsubscribe = broadcaster.subscribe('org_a', (event) => seenA.push(event))
    broadcaster.subscribe('org_b', (event) => seenB.push(event))

    broadcaster.publish({ id: 'e1', org_id: 'org_a', seq: 1, kind: 'card.created',
      board_id: null, actor_device_id: null, payload: {}, created_at: 'now' })

    expect(seenA.length).toBe(1)
    expect(seenB.length).toBe(0)

    unsubscribe()
    broadcaster.publish({ id: 'e2', org_id: 'org_a', seq: 2, kind: 'card.created',
      board_id: null, actor_device_id: null, payload: {}, created_at: 'now' })
    expect(seenA.length).toBe(1)
  })

  const evt = (orgId: string, seq: number): HubEvent => ({
    id: `${orgId}-${seq}`, org_id: orgId, seq, kind: 'card.created',
    board_id: null, actor_device_id: null, payload: {}, created_at: 'now',
  })

  it('never double-delivers a seq when two concurrent ops publish overlapping ranges', () => {
    const broadcaster = new HubBroadcaster()
    const seen: number[] = []
    broadcaster.subscribe('org_a', (e) => seen.push(e.seq))

    // op A's publish loop appends and publishes seq 1, then seq 2
    broadcaster.publish(evt('org_a', 1))
    broadcaster.publish(evt('org_a', 2))
    // op B raced with A: its own `before`/`after` snapshot span the same window, so
    // its publish loop reads the same union [1, 2] plus its own new seq 3
    broadcaster.publish(evt('org_a', 1))
    broadcaster.publish(evt('org_a', 2))
    broadcaster.publish(evt('org_a', 3))

    expect(seen).toEqual([1, 2, 3])
  })

  it('does not let one org de-dup suppress another org', () => {
    const broadcaster = new HubBroadcaster()
    const seenA: number[] = []
    const seenB: number[] = []
    broadcaster.subscribe('org_a', (e) => seenA.push(e.seq))
    broadcaster.subscribe('org_b', (e) => seenB.push(e.seq))

    broadcaster.publish(evt('org_a', 5))
    broadcaster.publish(evt('org_b', 1)) // org_b starts at seq 1 — must not be swallowed by org_a's seq 5

    expect(seenA).toEqual([5])
    expect(seenB).toEqual([1])
  })
})

describe('streamOrgEvents backlog/live boundary', () => {
  const evt = (seq: number): HubEvent => ({
    id: `e${seq}`, org_id: 'org_a', seq, kind: 'card.created',
    board_id: null, actor_device_id: null, payload: {}, created_at: 'now',
  })

  it('delivers an event committed mid-drain exactly once, in the right order', async () => {
    const written: HubEvent[] = []
    const write = (e: HubEvent) => written.push(e)

    let call = 0
    let resolvePage2!: (rows: HubEvent[]) => void
    const readBacklog = vi.fn(async (_cursor: number, _limit: number) => {
      call++
      if (call === 1) return [evt(1), evt(2)]
      if (call === 2) return new Promise<HubEvent[]>((resolve) => { resolvePage2 = resolve })
      return []
    })

    let liveListener: ((e: HubEvent) => void) | undefined
    const subscribe = (listener: (e: HubEvent) => void) => {
      liveListener = listener
      return () => { liveListener = undefined }
    }

    const promise = streamOrgEvents({ since: 0, pageSize: 2, readBacklog, subscribe, write })

    // Let the first page (a full page — length === pageSize, so the drain loop asks
    // for a second one) resolve and the second read start, without letting it finish.
    await new Promise((r) => setImmediate(r))
    expect(written.map((e) => e.seq)).toEqual([1, 2])

    // Event 3 commits and publishes live WHILE the drain's second read is still
    // pending — this is exactly the boundary the brief calls out as the subtle bug.
    liveListener?.(evt(3))
    // It must NOT be written immediately: the drain hasn't yet confirmed there is
    // nothing between 2 and 3 in the durable log (its second page is still pending).
    expect(written.map((e) => e.seq)).toEqual([1, 2])

    // The durable log has nothing more between 2 and what the live publish already
    // told us about.
    resolvePage2([])
    await promise

    expect(written.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('drops a live event that duplicates one the backlog already delivered', async () => {
    const written: HubEvent[] = []
    const write = (e: HubEvent) => written.push(e)

    let call = 0
    const readBacklog = vi.fn(async (_cursor: number, _limit: number) => {
      call++
      if (call === 1) return [evt(1), evt(2)]
      if (call === 2) return [evt(3)] // the durable log already has it by the time we ask
      return []
    })

    let liveListener: ((e: HubEvent) => void) | undefined
    const subscribe = (listener: (e: HubEvent) => void) => {
      liveListener = listener
      return () => { liveListener = undefined }
    }

    const promise = streamOrgEvents({ since: 0, pageSize: 2, readBacklog, subscribe, write })
    // The same event also arrives live — a duplicate of what the backlog page will
    // deliver a moment later.
    liveListener?.(evt(3))
    await promise

    expect(written.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('returns a working unsubscribe and keeps live delivery flowing after the drain', async () => {
    const written: HubEvent[] = []
    const write = (e: HubEvent) => written.push(e)
    const readBacklog = vi.fn(async () => [])

    let liveListener: ((e: HubEvent) => void) | undefined
    let unsubscribed = false
    const subscribe = (listener: (e: HubEvent) => void) => {
      liveListener = listener
      return () => { unsubscribed = true }
    }

    const unsubscribe = await streamOrgEvents({ since: 0, readBacklog, subscribe, write })
    liveListener?.(evt(1))
    expect(written.map((e) => e.seq)).toEqual([1])

    unsubscribe()
    expect(unsubscribed).toBe(true)
  })
})
