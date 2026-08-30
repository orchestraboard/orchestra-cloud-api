import type { FastifyPluginAsync, FastifyPluginOptions } from 'fastify'
import { readOrgEventsSince } from '../events.js'
import { ValidationError } from '../errors.js'
import { requireOrgScope } from '../scope.js'
import type { HubBroadcaster } from '../broadcast.js'
import type { HubSqlPool } from '../sql.js'
import type { HubEvent } from '../types.js'

export interface HubSyncRouteOptions extends FastifyPluginOptions {
  sql: HubSqlPool
  broadcast: HubBroadcaster
  heartbeatMs?: number
  /** Test seam only — production always uses the default `BACKLOG_PAGE`. */
  backlogPageSize?: number
}

const BACKLOG_PAGE = 500

export interface StreamOrgEventsOptions {
  since: number
  pageSize?: number
  readBacklog: (cursor: number, limit: number) => Promise<HubEvent[]>
  subscribe: (listener: (event: HubEvent) => void) => () => void
  write: (event: HubEvent) => void
}

/**
 * Drains the durable backlog from `since`, then hands back a live subscription that
 * keeps delivering events as they publish — with the guarantee that an event
 * committed while the drain is still in flight is delivered exactly once, never
 * skipped and never duplicated, no matter how the drain reads and the live publish
 * happen to interleave.
 *
 * The subscription attaches BEFORE the drain starts, so nothing published from this
 * point on can be missed. But anything it receives while `draining` is still true is
 * buffered rather than written immediately: writing it immediately could jump the
 * client ahead of backlog pages the drain hasn't reached yet (out-of-order delivery),
 * and — because the drain's next page reads `seq > cursor` — it would then silently
 * skip every event between the drain's current position and the jumped-ahead one.
 * Once the drain empties, the buffer is sorted and flushed against the drain's final
 * cursor: anything already delivered by the backlog (`seq <= cursor`) is dropped as a
 * would-be duplicate, everything else is written and folded into the cursor. From
 * then on, live events go straight through the same filtered write path.
 *
 * Exported (not route-private) so this interleaving can be exercised deterministically
 * in a test — by holding `readBacklog`'s promise open and calling the subscribed
 * listener manually before resolving it — rather than relying on real timing to lose
 * a race in CI.
 */
export async function streamOrgEvents(options: StreamOrgEventsOptions): Promise<() => void> {
  const { since, readBacklog, subscribe, write } = options
  const pageSize = options.pageSize ?? BACKLOG_PAGE

  let cursor = since
  let draining = true
  const buffered: HubEvent[] = []

  const unsubscribe = subscribe((event) => {
    if (draining) {
      buffered.push(event)
      return
    }
    if (event.seq <= cursor) return
    cursor = event.seq
    write(event)
  })

  for (;;) {
    const page = await readBacklog(cursor, pageSize)
    if (page.length === 0) break
    for (const event of page) write(event)
    cursor = page[page.length - 1].seq
    if (page.length < pageSize) break
  }

  draining = false
  buffered.sort((a, b) => a.seq - b.seq)
  for (const event of buffered) {
    if (event.seq <= cursor) continue
    cursor = event.seq
    write(event)
  }

  return unsubscribe
}

export const hubSyncPlugin: FastifyPluginAsync<HubSyncRouteOptions> = async (app, options) => {
  const { sql, broadcast } = options
  const heartbeatMs = options.heartbeatMs ?? 25_000

  app.get('/orgs/:orgId/sync', async (request, reply) => {
    const orgId = requireOrgScope(request)

    const query = (request.query ?? {}) as Record<string, string>
    // Parsed BEFORE anything touches `reply.raw`: a validation error thrown after
    // headers are written can't produce a clean 400 — the client already has a 200.
    const since = parseSince(query.since)
    // `catchup=1` drains the backlog (plus anything that lands during the drain) and
    // ends the response — this is how tests and one-shot resyncs avoid holding an
    // open stream.
    const catchupOnly = query.catchup === '1'

    // Fastify owns the reply lifecycle by default and will try to `send()` whatever
    // this async handler resolves with. We're writing the raw socket ourselves
    // (headers now, an unbounded number of frames after), so we take over the
    // lifecycle explicitly — otherwise Fastify's post-handler wrap-thenable calls
    // `reply.send()` a second time once this handler's promise resolves.
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })

    let ping: ReturnType<typeof setInterval> | null = null
    let liveUnsubscribe: (() => void) | null = null
    let torndown = false

    // A device-token stream is a daemon: register it as connected for as long as the
    // stream lives, so the devices listing can say "this machine is on right now".
    // Clerk-authenticated requests (a browser) carry no hubDevice and register nothing.
    const detachDevice = request.hubDevice
      ? broadcast.attachDevice(orgId, request.hubDevice.id)
      : null

    // Registered BEFORE the drain starts, not after `streamOrgEvents` resolves: the
    // broadcaster subscription attaches at the very top of that call, so a client
    // that disconnects while a long backlog drain is still in flight must be cleaned
    // up right away rather than leaking the subscription (and later installing a
    // ping for a connection that's already dead) until the drain finally finishes.
    // `liveUnsubscribe` is captured synchronously the moment `subscribe()` runs
    // below — `streamOrgEvents` calls it before its first `await` — so it's set well
    // before this handler can yield back to the event loop.
    const teardown = () => {
      if (torndown) return
      torndown = true
      request.raw.off('close', teardown)
      if (ping) clearInterval(ping)
      liveUnsubscribe?.()
      detachDevice?.()
    }
    request.raw.on('close', teardown)

    const write = (event: HubEvent) => {
      if (torndown) return
      reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
    }

    await streamOrgEvents({
      since,
      pageSize: options.backlogPageSize ?? BACKLOG_PAGE,
      readBacklog: (cursor, limit) => readOrgEventsSince(sql, orgId, cursor, limit),
      subscribe: (listener) => {
        const unsubscribe = broadcast.subscribe(orgId, listener)
        liveUnsubscribe = unsubscribe
        return unsubscribe
      },
      write,
    })

    // The client may already be gone by the time the drain finishes — either it
    // disconnected mid-drain (handled above) or the raw socket was torn down some
    // other way we haven't observed yet. Either way, don't install a ping for a dead
    // connection and don't try to end an already-torn-down response.
    if (torndown) return
    if (request.raw.destroyed) { teardown(); return }

    if (catchupOnly) {
      teardown()
      reply.raw.end()
      return
    }

    ping = setInterval(() => reply.raw.write(': ping\n\n'), heartbeatMs)
  })
}

function parseSince(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new ValidationError('since must be a non-negative integer')
  return value
}
