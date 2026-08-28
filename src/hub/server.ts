import Stripe from 'stripe'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { hubOpsPlugin } from './routes/ops.js'
import { hubSyncPlugin } from './routes/sync.js'
import { HubBroadcaster } from './broadcast.js'
import { verifyDeviceToken, DEVICE_TOKEN_PREFIX, type HubDevice } from './devices.js'
import { verifyClerkToken, resolveOrgForClerk } from './clerk.js'
import { hubClerkWebhookPlugin } from './webhooks/clerk.js'
import { hubStripeWebhookPlugin, type StripeWebhookClient } from './webhooks/stripe.js'
import { createCheckoutSession, createPortalSession, type StripeBillingClient } from './billing.js'
import { entitlementsFor } from './entitlements.js'
import { mintDeviceToken } from './devices.js'
import { HubError, ValidationError, ForbiddenError } from './errors.js'
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
  /** From HubEnv#clerkWebhookSigningSecret. Verifies Clerk's own webhook signature at
   * POST /webhooks/clerk — see src/hub/webhooks/clerk.ts. Omitted (or unset) means that
   * route always answers 500 rather than ever accepting an unsigned payload. */
  clerkWebhookSigningSecret?: string
  /** From HubEnv#stripeSecretKey. Builds the one `Stripe` client this process uses for
   * checkout/portal session creation and for fetching subscriptions the webhook needs.
   * Omitted (or unset) means the billing routes and webhook always answer with "not
   * configured" rather than ever running unauthenticated Stripe calls. Ignored if
   * `stripeClient` is also given. */
  stripeSecretKey?: string
  /** From HubEnv#stripeWebhookSecret. Verifies Stripe's own webhook signature at
   * POST /webhooks/stripe — see src/hub/webhooks/stripe.ts. Omitted (or unset) means that
   * route always answers 500 rather than ever accepting an unsigned payload. */
  stripeWebhookSecret?: string
  /** Test-only injection point: overrides the Stripe client `buildHubServer` would otherwise
   * construct from `stripeSecretKey`. Production never sets this — src/hub-cli.ts and
   * src/hub-entry.ts only ever pass `stripeSecretKey`. Lets tests exercise checkout, portal,
   * and the webhook against a mock rather than a real Stripe API call. */
  stripeClient?: StripeBillingClient & StripeWebhookClient
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
  // Mounted OUTSIDE `/api/v1/hub/` — the onRequest hook above returns early for
  // any URL not under that prefix, so this route is unauthenticated by that
  // hook by design: it verifies Clerk's own Svix signature instead of a
  // bearer token. See src/hub/webhooks/clerk.ts.
  server.register(hubClerkWebhookPlugin, { sql, env: { clerkWebhookSigningSecret: opts.clerkWebhookSigningSecret } })

  // `opts.stripeClient` (test injection) wins over building one from `stripeSecretKey` — see
  // the doc comment on HubServerOptions#stripeClient. A real `Stripe` instance satisfies both
  // `StripeBillingClient` and `StripeWebhookClient` structurally, so it needs no adaptation.
  const stripe: (StripeBillingClient & StripeWebhookClient) | null =
    opts.stripeClient ?? (opts.stripeSecretKey ? new Stripe(opts.stripeSecretKey) : null)

  // Mounted OUTSIDE `/api/v1/hub/`, same reasoning as the Clerk webhook above: it carries its
  // own Stripe signature instead of a bearer token. See src/hub/webhooks/stripe.ts. Registered
  // even when `stripe` is null — the route itself still needs to exist to answer "not
  // configured" rather than 404, matching the Clerk webhook's stance when its secret is unset.
  server.register(hubStripeWebhookPlugin, {
    sql,
    env: { stripeWebhookSecret: opts.stripeWebhookSecret },
    stripe: stripe ?? NOT_CONFIGURED_STRIPE_CLIENT,
  })

  // Authenticated (inside `/api/v1/hub/`, so the onRequest hook above resolves and scopes
  // `request.hubOrgId` the same way every other org-scoped route does) thin wrappers around
  // src/hub/billing.ts. Kept inline here rather than as their own routes/ file — this task's
  // brief scopes its server.ts change to wiring, not a new plugin file.
  server.post('/api/v1/hub/orgs/:orgId/billing/checkout', async (request, reply) => {
    if (!stripe) return reply.code(500).send({ error: 'billing is not configured', code: 'internal_error' })
    const orgId = requireHubOrgId(request)
    const body = (request.body ?? {}) as Record<string, unknown>
    const lookupKey = typeof body.lookup_key === 'string' ? body.lookup_key : ''
    const quantity = typeof body.quantity === 'number' ? body.quantity : undefined
    const result = await createCheckoutSession(sql, stripe, { orgId, lookupKey, quantity })
    return reply.send(result)
  })

  server.post('/api/v1/hub/orgs/:orgId/billing/portal', async (request, reply) => {
    if (!stripe) return reply.code(500).send({ error: 'billing is not configured', code: 'internal_error' })
    const orgId = requireHubOrgId(request)
    const result = await createPortalSession(sql, stripe, { orgId })
    return reply.send(result)
  })

  // A read, like the org-scoped GETs in routes/ops.ts — never gated by
  // `assertOrgWritable`, deliberately: a suspended org must still be able to load its
  // own billing page (Task 7) to see why it's suspended and fix it. `seats`/`agents`
  // pair the cached entitlement against a LIVE count each time — usage is never
  // cached (see entitlements.ts) so this can't drift from what `assertAgentCapacity`
  // itself would see. `tier` isn't part of `EntitlementSnapshot`'s contract (kept
  // narrow to what Task 6's enforcement functions need) but is cheap to add here for
  // the billing page's "current plan" display.
  server.get('/api/v1/hub/orgs/:orgId/entitlements', async (request, reply) => {
    const orgId = requireHubOrgId(request)
    const entitlement = await entitlementsFor(sql, orgId)
    const [memberships, agents, subscription] = await Promise.all([
      sql.query<{ n: string }>('SELECT count(*)::text AS n FROM memberships WHERE org_id = $1', [orgId]),
      sql.query<{ n: string }>("SELECT count(*)::text AS n FROM agents WHERE org_id = $1 AND state <> 'offline'", [orgId]),
      sql.query<{ tier: string }>('SELECT tier FROM subscriptions WHERE org_id = $1', [orgId]),
    ])
    const seatsUsed = Number(memberships.rows[0]?.n ?? 0)
    const agentsUsed = Number(agents.rows[0]?.n ?? 0)
    return reply.send({
      tier: subscription.rows[0]?.tier ?? 'none',
      status: entitlement.status,
      sso: entitlement.sso,
      // `overCap` on seats: memberships are never gated at creation (Clerk owns
      // membership truth — see entitlements.ts's assertSeatAvailable doc comment),
      // only at device-token minting, so a membership count above `entitled` is an
      // expected, visible state, not a bug — this is what lets the UI prompt an
      // upgrade instead of a member only discovering the cap when their daemon
      // pairing is refused.
      seats: { used: seatsUsed, entitled: entitlement.seats, overCap: seatsUsed > entitlement.seats },
      agents: { used: agentsUsed, entitled: entitlement.concurrentAgents, overCap: agentsUsed > entitlement.concurrentAgents },
    })
  })

  // Task 7 defect found while wiring the web UI: nothing exposed the mapping from a
  // signed-in browser's selected Clerk org to THIS hub's own `orgs.id` (a random
  // `org_<uuid>` minted by the Clerk `organization.created` webhook — see
  // webhooks/clerk.ts — never derivable from the Clerk org id the browser actually
  // has). Every other org-scoped route takes `:orgId` in its path and 403s if it
  // doesn't match what the token resolves to (see the onRequest hook above), so a
  // browser that doesn't already know its internal org id has no way to call any of
  // them. This route has no `:orgId` segment — `requestedOrg` above is therefore
  // `undefined` and the hook's match check never runs — so it works as the one
  // bootstrap call a freshly signed-in client makes before every other request.
  server.get('/api/v1/hub/me', async (request, reply) => {
    if (!request.hubUserId) {
      throw new ForbiddenError('sign in required')
    }
    return reply.send({ user_id: request.hubUserId, org_id: request.hubOrgId })
  })

  // Task 7: `mintDeviceToken` (devices.ts) previously had no HTTP route — it was
  // reachable only from tests, so no daemon could ever obtain a token. Deliberately
  // restricted to a Clerk-authenticated caller (`request.hubUserId` set): a device
  // token minting *another* device token has no member behind it to rank for the
  // seat cap (`assertSeatAvailable` below is then a no-op — see its doc comment in
  // entitlements.ts), which would let one paired daemon hand out unlimited further
  // daemons for free. A signed-in member, by contrast, always has exactly one
  // membership row in their own org, which is what the seat cap actually meters.
  server.post('/api/v1/hub/orgs/:orgId/devices', async (request, reply) => {
    const orgId = requireHubOrgId(request)
    if (!request.hubUserId) {
      throw new ForbiddenError('only a signed-in member can mint a device token')
    }
    const membership = await sql.query<{ id: string }>(
      'SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, request.hubUserId],
    )
    const membershipId = membership.rows[0]?.id
    if (!membershipId) {
      throw new ForbiddenError('user is not a member of this org')
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name : ''
    // Seat enforcement lives entirely inside `mintDeviceToken` → `assertSeatAvailable`
    // (entitlements.ts) — not duplicated here. A `ForbiddenError` from an over-cap
    // member reaches the client via the error handler below with its actionable
    // message intact (see `INVALID_TOKEN_BODY`'s comment for why *that* path stays
    // generic — this one is different: the membership already verified above, so
    // there's no "which token is real" oracle to protect).
    const { device, token } = await mintDeviceToken(sql, { orgId, membershipId, name })
    return reply.code(201).send({ device, token })
  })

  server.get('/healthz', async () => ({ ok: true, presence_ttl_seconds: opts.presenceTtlSeconds ?? 45 }))

  return server
}

function requireHubOrgId(request: FastifyRequest): string {
  const orgId = request.hubOrgId
  if (!orgId) throw new ValidationError('org scope was not resolved')
  return orgId
}

/**
 * Stands in for `stripe` in the webhook plugin registration when no Stripe client exists at
 * all (`stripeSecretKey` unset and no `stripeClient` override) — the plugin's own `env.secret`
 * check always answers 500 before either method here would ever run, so these throwing stubs
 * exist only to satisfy the plugin's required `stripe` option, never to be called.
 */
const NOT_CONFIGURED_STRIPE_CLIENT: StripeWebhookClient = {
  webhooks: {
    constructEventAsync() {
      throw new Error('stripe is not configured')
    },
  },
  subscriptions: {
    retrieve() {
      throw new Error('stripe is not configured')
    },
  },
}
