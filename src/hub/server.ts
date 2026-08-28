import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { hubOpsPlugin } from './routes/ops.js'
import { hubSyncPlugin } from './routes/sync.js'
import { HubBroadcaster } from './broadcast.js'
import { verifyDeviceToken, DEVICE_TOKEN_PREFIX, type HubDevice } from './devices.js'
import { verifyClerkToken, resolveOrgForClerk } from './clerk.js'
import { HubError } from './errors.js'
import { registerHubCors } from './cors.js'
import type { HubSqlPool } from './sql.js'

declare module 'fastify' {
  interface FastifyRequest {
    hubDevice: HubDevice | null
    hubOrgId: string | null
    /** Set for a Clerk-authenticated browser request; null for a device token. */
    hubUserId: string | null
  }
  interface FastifyInstance {
    /** Exposed for tests that need to assert on subscriber counts / leak-freedom. */
    hubBroadcast: HubBroadcaster
  }
}

export interface HubServerOptions {
  presenceTtlSeconds?: number
  /** The single browser origin (Vercel-hosted web UI) allowed cross-origin access. See src/hub/cors.ts. */
  webOrigin?: string
  /** From HubEnv#clerkSecretKey. Omitted (or unset) means Clerk JWTs are never accepted — only device tokens. */
  clerkSecretKey?: string
}

/**
 * A single generic message for "token never existed" and "token was revoked" —
 * and, since Task 3, for every way a Clerk JWT can fail to verify too.
 * `verifyDeviceToken` deliberately throws different `.message` strings for the
 * device-token cases so the domain layer and logs stay diagnosable, but if that
 * distinction reached an HTTP client it would let an attacker probe which
 * tokens are real. Every failure to authenticate — bad format, unknown hash,
 * revoked, bad signature, expired — collapses to this one body, regardless of
 * which token type it came from. See clerk.ts's CLERK_TOKEN_INVALID comment
 * for why a *second* generic wording would reintroduce the same oracle this
 * body exists to prevent.
 */
const INVALID_TOKEN_BODY = { error: 'device token is not valid', code: 'forbidden' } as const

/** Distinct from INVALID_TOKEN_BODY on purpose: this token verified fine (it's a genuine, signed
 * Clerk session), so there's nothing to hide — the user just isn't in this org. Compare to the
 * device-token path's existing "device is not a member of this org" 403, which is equally explicit. */
const NOT_A_MEMBER_BODY = { error: 'user is not a member of this org', code: 'forbidden' } as const

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
  server.decorateRequest('hubUserId', null)

  // Registered before the auth hook below: @fastify/cors answers preflight
  // OPTIONS requests from its own onRequest hook (registered in call order,
  // same as the auth hook), so it must run first or a browser's preflight —
  // sent with no Authorization header — would be rejected by the auth check
  // before CORS ever got a chance to approve it.
  registerHubCors(server, opts.webOrigin)

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
   *
   * Since Task 3, the bearer token is either a device token (daemons) or a
   * Clerk session JWT (signed-in browsers). The two are discriminated by
   * SHAPE — the `orchestra_device_v1.` prefix — never by trial: a Clerk token
   * never reaches `verifyDeviceToken` (that would cost a DB round trip on
   * every browser request just to fail), and a device token never reaches
   * `verifyClerkToken` (that would cost a Clerk network/JWKS round trip on
   * every daemon request just to fail).
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

    const requestedOrg = (request.params as any)?.orgId

    if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
      let device: HubDevice
      try {
        device = await verifyDeviceToken(sql, token)
      } catch {
        // Deliberately drop the caught error's own message/status — see
        // INVALID_TOKEN_BODY above. Do not branch on `error instanceof HubError`
        // here; that branch is exactly what would leak "unknown" vs "revoked".
        return reply.code(403).send(INVALID_TOKEN_BODY)
      }

      if (typeof requestedOrg === 'string' && requestedOrg !== device.org_id) {
        return reply.code(403).send({ error: 'device is not a member of this org', code: 'forbidden' })
      }

      request.hubDevice = device
      request.hubOrgId = device.org_id
      request.hubUserId = null
      return
    }

    let principal: Awaited<ReturnType<typeof verifyClerkToken>>
    try {
      principal = await verifyClerkToken(token, { clerkSecretKey: opts.clerkSecretKey })
    } catch {
      // Same collapse as the device-token path above, and for the same reason:
      // an attacker holding a dead Clerk token must not be able to tell "bad
      // signature" apart from "expired" apart from "device token that also
      // happens to be malformed" by response shape.
      return reply.code(403).send(INVALID_TOKEN_BODY)
    }

    let resolved: Awaited<ReturnType<typeof resolveOrgForClerk>>
    try {
      resolved = await resolveOrgForClerk(sql, principal)
    } catch {
      // Unlike the two catches above, this token verified fine — the user is
      // a real, currently-authenticated person. There is no "unknown vs.
      // revoked" ambiguity to protect by staying generic, so this can and
      // does name the actual reason (mirrors the device path's own
      // "not a member of this org" 403 a few lines up).
      return reply.code(403).send(NOT_A_MEMBER_BODY)
    }

    if (typeof requestedOrg === 'string' && requestedOrg !== resolved.orgId) {
      return reply.code(403).send(NOT_A_MEMBER_BODY)
    }

    request.hubDevice = null
    request.hubOrgId = resolved.orgId
    request.hubUserId = resolved.userId
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
