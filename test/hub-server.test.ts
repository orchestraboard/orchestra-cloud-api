import { describe, it, expect, afterEach } from 'vitest'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { mintDeviceToken, revokeDevice } from '../src/hub/devices.js'
import { seedOrg } from './support/hub-sql.js'

afterEach(async () => { await closeHubServers() })

describe('hub server', () => {
  it('rejects an unauthenticated op', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`,
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'x' } },
    })
    expect(response.statusCode).toBe(403)

    // The handler must genuinely never have run: no card exists.
    const cards = await hub.sql.query('SELECT * FROM cards WHERE org_id = $1', [hub.orgId])
    expect(cards.rows.length).toBe(0)
  })

  it('creates a card through the ops endpoint', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Ship the hub' } },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.result.title).toBe('Ship the hub')
    expect(body.result.version).toBe(1)
    expect(body.seq).toBe(1)
  })

  it('refuses a device token minted for a different org', async () => {
    const hub = await hubFixture()
    await seedOrg(hub.sql, 'org_b')
    const other = await mintDeviceToken(hub.sql, { orgId: 'org_b', name: 'intruder' })

    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(other.token),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Cross-org' } },
    })
    expect(response.statusCode).toBe(403)
  })

  it('refuses a foreign-org token on every read route, not just ops', async () => {
    // This is the real proof that Fastify populates request.params before
    // onRequest fires: the org-mismatch check in the hook reads
    // request.params.orgId, and these are GET routes with no body at all — if
    // params were not yet populated when the hook ran, requestedOrg would be
    // undefined and every one of these would silently fall through to 200.
    const hub = await hubFixture()
    await seedOrg(hub.sql, 'org_b')
    const other = await mintDeviceToken(hub.sql, { orgId: 'org_b', name: 'intruder' })
    const headers = hub.auth(other.token)

    const cards = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`, headers,
    })
    expect(cards.statusCode).toBe(403)

    const agents = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/agents`, headers,
    })
    expect(agents.statusCode).toBe(403)

    const inbox = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/mail/inbox?agent=someone`, headers,
    })
    expect(inbox.statusCode).toBe(403)
  })

  it('returns 409 with current state when two devices race a claim', async () => {
    const hub = await hubFixture()
    const created = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Contested' } },
    })
    const cardId = created.json().result.id

    const first = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.claim', payload: { card_id: cardId, agent: 'agent-one' } },
    })
    expect(first.statusCode).toBe(200)

    const second = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.claim', payload: { card_id: cardId, agent: 'agent-two' } },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('conflict')
    expect(second.json().current.owner_agent).toBe('agent-one')
  })

  it('applies a replayed idempotency key exactly once', async () => {
    const hub = await hubFixture()
    const op = {
      op: 'card.create', idempotency_key: 'queued-op-1',
      payload: { board_id: hub.boardId, title: 'Replayed' },
    }
    const first = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(), payload: op,
    })
    const second = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(), payload: op,
    })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    const cards = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`, headers: hub.auth(),
    })
    expect(cards.json().cards.filter((c: any) => c.title === 'Replayed').length).toBe(1)
  })

  it('rejects an unknown op name', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.delete_everything', payload: {} },
    })
    expect(response.statusCode).toBe(400)
  })

  it('gives byte-identical 403 bodies for an unknown token and a revoked one', async () => {
    // devices.ts verifyDeviceToken throws distinct messages ("not valid" vs
    // "has been revoked") for these two cases on purpose, so logs stay
    // diagnosable. The HTTP layer must destroy that distinction: an attacker
    // holding a dead token must not be able to tell "never existed" apart
    // from "existed and was revoked" by the response shape.
    const hub = await hubFixture()
    const minted = await mintDeviceToken(hub.sql, { orgId: hub.orgId, name: 'soon-revoked' })
    await revokeDevice(hub.sql, hub.orgId, minted.device.id)

    const neverExisted = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: 'Bearer orchestra_device_v1.totally-made-up' },
    })
    const revoked = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: `Bearer ${minted.token}` },
    })

    expect(neverExisted.statusCode).toBe(403)
    expect(revoked.statusCode).toBe(403)
    expect(revoked.payload).toBe(neverExisted.payload)
  })

  it('never leaks a raw database error through the ops endpoint', async () => {
    // `expected_version` is validated as a positive integer but not as one that
    // fits `cards.version` (INTEGER), so a value past int4 makes Postgres fail the
    // UPDATE's parameter coercion with SQLSTATE 22003. That is a genuine, unmapped
    // database error raised deterministically through the ops endpoint — not a
    // HubError, and not something the handler was special-cased around. Confirms
    // the generic setErrorHandler catch (the concern raised about registerAgent's
    // race) holds for an unmapped error in general, not just that one code path.
    const hub = await hubFixture()
    const created = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Card' } },
    })
    const cardId = created.json().result.id

    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: {
        op: 'card.update',
        payload: { card_id: cardId, expected_version: 1_000_000_000_000_000, title: 'Renamed' },
      },
    })

    expect(response.statusCode).toBe(500)
    const body = response.json()
    expect(body).toEqual({ error: 'internal error', code: 'internal_error' })
    const raw = response.payload.toLowerCase()
    expect(raw).not.toContain('out of range')
    expect(raw).not.toContain('sqlstate')
    expect(raw).not.toContain('22003')
    expect(raw).not.toContain(' at ') // no stack trace frame text
  })

  it('maps a concurrent agent.register race to a well-formed response, never a raw error body', async () => {
    // registerAgent (presence.ts) does SELECT-then-INSERT with no lock, so N
    // concurrent registrations of the same (org, board, name) can all pass the
    // SELECT before any INSERT commits and collide on the UNIQUE(org_id,
    // board_id, name) constraint. This is a best-effort reproduction of that
    // race (timing-dependent, not guaranteed to trigger under PGlite's
    // single-connection model) — registerAgent itself is out of scope to fix
    // here. What must hold regardless of whether the race actually fires this
    // run: every response is either a clean 200 or a generic mapped error,
    // never a raw driver error leaking through.
    const hub = await hubFixture()
    const attempt = () => hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'agent.register', payload: { board_id: hub.boardId, name: 'racer' } },
    })
    const responses = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()])

    for (const response of responses) {
      expect([200, 500]).toContain(response.statusCode)
      if (response.statusCode === 500) {
        expect(response.json()).toEqual({ error: 'internal error', code: 'internal_error' })
      }
    }
    expect(responses.some((r) => r.statusCode === 200)).toBe(true)

    const agents = await hub.sql.query(
      'SELECT * FROM agents WHERE org_id = $1 AND board_id = $2 AND name = $3',
      [hub.orgId, hub.boardId, 'racer'],
    )
    expect(agents.rows.length).toBe(1)
  })
})
