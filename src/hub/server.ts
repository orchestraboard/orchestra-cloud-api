import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { hubOpsPlugin } from './routes/ops.js'
import { hubSyncPlugin } from './routes/sync.js'
import { HubBroadcaster } from './broadcast.js'
import { verifyDeviceToken, type HubDevice } from './devices.js'
import { HubError } from './errors.js'
import type { HubSqlPool } from './sql.js'

declare module 'fastify' {
  interface FastifyRequest {
    hubDevice: HubDevice | null
    hubOrgId: string | null
  }
  interface FastifyInstance {
    /** Exposed for tests that need to assert on subscriber counts / leak-freedom. */
    hubBroadcast: HubBroadcaster
  }
}

export interface HubServerOptions {
  presenceTtlSeconds?: number
}

/**
 * A single generic message for "token never existed" and "token was revoked".
 * `verifyDeviceToken` deliberately throws different `.message` strings for the
 * two cases so the domain layer and logs stay diagnosable, but if that
 * distinction reached an HTTP client it would let an attacker probe which
 * tokens are real. Every failure to authenticate — bad format, unknown hash,
 * revoked — collapses to this one body.
 */
const INVALID_TOKEN_BODY = { error: 'device token is not valid', code: 'forbidden' } as const

/**
 * The hub's own Fastify app. It deliberately does NOT reuse `buildServer()` from
 * src/server.ts: that factory takes a synchronous better-sqlite3 handle and is
 * single-tenant by construction. Conventions are shared; code is not.
 */
export function buildHubServer(sql: HubSqlPool, opts: HubServerOptions = {}): FastifyInstance {
  const server = Fastify({
    // Railway terminates TLS and proxies every request through its edge, so
    // without this, `request.ip` and `request.protocol` would report the
    // proxy's address/scheme instead of the client's.
    trustProxy: true,
    // Only request metadata (method, url, status, latency) is logged by
    // Fastify's default serializers — never headers or the body, which carry
    // bearer tokens (see the auth hook below).
    logger: true,
  })
  server.decorateRequest('hubDevice', null)
  server.decorateRequest('hubOrgId', null)

  /**
   * One place resolves identity and org scope. Handlers read `request.hubOrgId`
   * and never take an org id from the body — cross-org access is therefore not a
   * mistake a route author can make.
   *
   * This runs as an `onRequest` hook, before body parsing, so it never has to
   * trust anything the client sent except the header and the already-matched
   * route params. Fastify resolves the route (and therefore `request.params`)
   * before invoking `onRequest` hooks, because which hooks apply can itself be
   * route-specific — see the "request.params is available in onRequest"
   * assertion in test/hub-server.test.ts, which exercises this directly rather
   * than trusting it.
   */
  server.addHook('onRequest', async (request: FastifyRequest, reply) => {
    reply.header('cache-control', 'no-store')
    if (!request.url.startsWith('/api/v1/hub/')) return

    const header = request.headers.authorization
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : ''
    if (!token) {
      return reply.code(403).send({ error: 'device token is required', code: 'forbidden' })
    }

    let device: HubDevice
    try {
      device = await verifyDeviceToken(sql, token)
    } catch {
      // Deliberately drop the caught error's own message/status — see
      // INVALID_TOKEN_BODY above. Do not branch on `error instanceof HubError`
      // here; that branch is exactly what would leak "unknown" vs "revoked".
      return reply.code(403).send(INVALID_TOKEN_BODY)
    }

    const requestedOrg = (request.params as any)?.orgId
    if (typeof requestedOrg === 'string' && requestedOrg !== device.org_id) {
      return reply.code(403).send({ error: 'device is not a member of this org', code: 'forbidden' })
    }

    request.hubDevice = device
    request.hubOrgId = device.org_id
  })

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof HubError) {
      const body: Record<string, unknown> = { error: error.message, code: error.code }
      if ('current' in error && (error as any).current !== undefined) body.current = (error as any).current
      return reply.code(error.statusCode).send(body)
    }
    // Anything else (a raw driver error, a programmer error, ...) never reaches
    // the client verbatim: no message, no stack, no SQLSTATE, no constraint
    // name. registerAgent's SELECT-then-INSERT race (see presence.ts) is one
    // concrete source of such an error today, but this is not special-cased to
    // it — every unmapped error funnels through this one generic body.
    server.log.error(error)
    return reply.code(500).send({ error: 'internal error', code: 'internal_error' })
  })

  const broadcast = new HubBroadcaster()
  server.decorate('hubBroadcast', broadcast)
  server.register(hubOpsPlugin, { sql, broadcast, prefix: '/api/v1/hub' })
  server.register(hubSyncPlugin, { sql, broadcast, prefix: '/api/v1/hub' })
  server.get('/healthz', async () => ({ ok: true, presence_ttl_seconds: opts.presenceTtlSeconds ?? 45 }))

  return server
}
