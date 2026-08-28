import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { syncSubscriptionFromStripe, type StripeSubscriptionLike } from '../billing.js'
import type { HubSqlPool } from '../sql.js'

export interface HubStripeWebhookEnv {
  stripeWebhookSecret?: string
}

/** Just enough of a Stripe `Event` for this handler's switch. `data.object`'s real shape
 * varies by `type`; each branch below narrows it itself. */
interface StripeEventLike {
  type: string
  data: { object: unknown }
}

/**
 * The minimal Stripe SDK surface this webhook needs beyond signature verification: fetching
 * the full subscription a `checkout.session.completed` session points at (that event's
 * `data.object` is a Checkout Session, which carries only a subscription ID, not the
 * subscription itself). Declared structurally, same convention as `StripeBillingClient` in
 * ../billing.ts — a mock satisfying this shape is enough to exercise every branch below without
 * a real Stripe API call.
 */
export interface StripeWebhookClient {
  webhooks: {
    constructEventAsync(payload: string | Buffer, header: string, secret: string): Promise<StripeEventLike>
  }
  subscriptions: {
    retrieve(id: string, params?: Record<string, unknown>): Promise<StripeSubscriptionLike>
  }
}

export interface HubStripeWebhookPluginOptions {
  sql: HubSqlPool
  env: HubStripeWebhookEnv
  /** Never constructed inside this module — see src/hub/server.ts, which builds the one Stripe
   * client the whole hub process uses (or a test's mock) and threads it through. */
  stripe: StripeWebhookClient
}

/**
 * Mirrors src/hub/webhooks/clerk.ts's raw-body handling exactly, for the same reason:
 * `stripe.webhooks.constructEventAsync` verifies a signature computed over the *exact* bytes
 * Stripe sent, and a body Fastify has already parsed into an object and would re-serialize
 * differently (key order, whitespace) fails that verification against real Stripe traffic even
 * though a test built the same way would pass.
 *
 * Mounted OUTSIDE `/api/v1/hub/` in server.ts — the bearer-token `onRequest` hook only applies
 * to that prefix, so this route carries its own Stripe signature instead of a bearer token,
 * same as the Clerk webhook.
 */
export const hubStripeWebhookPlugin: FastifyPluginAsync<HubStripeWebhookPluginOptions> = async (fastify, opts) => {
  const { sql, env, stripe } = opts

  // Scoped to this plugin's encapsulation context only (this file isn't wrapped with
  // fastify-plugin) — hubOpsPlugin/hubSyncPlugin's normal JSON bodies, and the Clerk webhook's
  // own raw-body parser registered in its own plugin, are both untouched by this.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  fastify.post('/webhooks/stripe', async (request, reply) => {
    const secret = env.stripeWebhookSecret
    if (!secret) {
      // Never fall through to "accept unsigned" just because ops forgot to configure the
      // secret. 5xx so Stripe keeps retrying until it's set, rather than giving up on a
      // permanent-looking 400 — mirrors the Clerk webhook's identical guard.
      request.log.error('stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured')
      return reply.code(500).send({ error: 'webhook not configured', code: 'internal_error' })
    }

    const signatureHeader = request.headers['stripe-signature']
    if (typeof signatureHeader !== 'string') {
      return reply.code(400).send({ error: 'missing stripe-signature header', code: 'validation_failed' })
    }

    let event: StripeEventLike
    try {
      event = await stripe.webhooks.constructEventAsync(request.body as Buffer, signatureHeader, secret)
    } catch {
      // Deliberately does not distinguish "bad signature" from "expired timestamp" from
      // "malformed header" — none of that is actionable to whoever (or whatever) sent this,
      // same stance as the Clerk webhook.
      return reply.code(400).send({ error: 'invalid webhook signature', code: 'validation_failed' })
    }

    await applyStripeEvent(sql, stripe, event, request)
    return reply.code(200).send({ ok: true })
  })
}

/**
 * Applies one verified Stripe event. Every branch either calls `syncSubscriptionFromStripe`
 * (itself idempotent — see its own doc comment in ../billing.ts) or is a deliberate no-op ack,
 * so replaying any event here converges to the same end state rather than duplicating anything.
 */
async function applyStripeEvent(
  sql: HubSqlPool, stripe: StripeWebhookClient, event: StripeEventLike, request: FastifyRequest,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as { subscription?: string | null }
      if (!session.subscription) {
        // A one-time-payment Checkout Session (mode: 'payment') rather than the
        // mode: 'subscription' sessions createCheckoutSession creates. Never expected in
        // practice — every price this hub sells is recurring — but ack rather than throw.
        request.log.info('stripe webhook: checkout.session.completed with no subscription, ack only')
        return
      }
      const subscription = await stripe.subscriptions.retrieve(session.subscription, {
        expand: ['items.data.price'],
      })
      await syncSubscriptionFromStripe(sql, subscription)
      return
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Both events' `data.object` IS the subscription already, with its full `items.data[]`
      // (including each item's `price`) embedded — no fetch needed. A `.deleted` event's
      // subscription has `status: 'canceled'`, which is what makes syncSubscriptionFromStripe
      // suspend the org: there's no separate "deleted" branch, the shared status mapping
      // already handles it.
      const subscription = event.data.object as StripeSubscriptionLike
      await syncSubscriptionFromStripe(sql, subscription)
      return
    }
    default:
      // An event type this hub doesn't act on (e.g. invoice.*, payment_intent.*). Acknowledged
      // as a no-op — erroring here would make Stripe retry an event forever.
      request.log.info({ eventType: event.type }, 'stripe webhook: unhandled event type, ack only')
      return
  }
}
