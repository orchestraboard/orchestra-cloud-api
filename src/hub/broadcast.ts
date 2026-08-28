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
    this.emitter.emit(`org:${event.org_id}`, event)
  }

  /** Number of live subscribers for an org — for tests asserting no listener leak. */
  listenerCount(orgId: string): number {
    return this.emitter.listenerCount(`org:${orgId}`)
  }
}
