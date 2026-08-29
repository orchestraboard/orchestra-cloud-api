import { EventEmitter } from 'node:events'
import type { HubEvent } from './types.js'

/**
 * In-process fan-out to the SSE streams attached to this instance. The durable
 * ordering guarantee lives in `org_events`, not here: a client that misses a live
 * frame recovers by reconnecting with `?since=`, so losing a broadcast is never
 * data loss. Multi-instance deployments add Postgres LISTEN/NOTIFY behind this
 * same interface (Plan 3, if a second instance is ever needed).
 */
export class HubBroadcaster {
  private readonly emitter = new EventEmitter()

  // The highest seq this instance has actually emitted, per org. `ops.ts` snapshots
  // `before`/`after` around each op's own DB work, and those snapshots span multiple
  // `await`s — so two ops committing concurrently in the same org can each end up
  // reading (and trying to publish) the same union of newly-appended events. This
  // guard is what makes `publish` keep its "publish exactly what this op appended"
  // contract even when a caller hands it something it (or another concurrent caller)
  // already published: `publish` is synchronous and Node is single-threaded, so the
  // compare-and-set below is atomic — no two calls can race each other for the same
  // org. Intentionally unbounded in entry count, but only by org, never by event or
  // by connection: an org is a long-lived tenant this process serves for its whole
  // lifetime, not a per-request or per-subscriber resource, so this cannot grow
  // without bound the way a cache keyed by event or connection would. It is not a
  // leak.
  private readonly lastPublishedSeq = new Map<string, number>()

  constructor() {
    // One listener per connected daemon per org; the default cap of 10 is too low.
    this.emitter.setMaxListeners(0)
  }

  subscribe(orgId: string, listener: (event: HubEvent) => void): () => void {
    const channel = `org:${orgId}`
    this.emitter.on(channel, listener)
    return () => { this.emitter.off(channel, listener) }
  }

  publish(event: HubEvent): void {
    const last = this.lastPublishedSeq.get(event.org_id) ?? 0
    if (event.seq <= last) return
    this.lastPublishedSeq.set(event.org_id, event.seq)
    this.emitter.emit(`org:${event.org_id}`, event)
  }

  /** Number of live subscribers for an org — for tests asserting no listener leak. */
  listenerCount(orgId: string): number {
    return this.emitter.listenerCount(`org:${orgId}`)
  }
}
