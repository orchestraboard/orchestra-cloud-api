import { ValidationError } from './errors.js'
import type { HubSqlPool } from './sql.js'

/**
 * Every price this hub is allowed to sell, keyed by lookup key — never by Stripe price id.
 * Lookup keys are identical across Stripe test and live mode (see the task brief), which is
 * what makes this module mode-agnostic; a hardcoded `price_…` id would work in test and break
 * in production.
 *
 * This is also the enforcement point for "the client cannot influence price or amount": a
 * caller supplies only a key from this fixed set, `createCheckoutSession` resolves it to a
 * real Stripe price via `stripe.prices.list`, and nothing else about the price (amount,
 * currency, product) ever flows from the request into the Stripe call.
 */
const LOOKUP_KEYS = new Set([
  'cloud_base_monthly', 'cloud_base_yearly',
  'cloud_seat_monthly', 'cloud_seat_yearly',
  'cloud_agent_pack_monthly', 'cloud_agent_pack_yearly',
  'cloud_sso_monthly', 'cloud_sso_yearly',
  'business_seat_monthly', 'business_seat_yearly',
])

/**
 * The minimal surface of the Stripe SDK `billing.ts` needs. Declared structurally — a plain
 * object with these methods mocked (as every test in this file does) satisfies it just as
 * well as a real `new Stripe(secretKey)` client, which is exactly what makes this module
 * testable without ever making a real Stripe API call. Mirrors the `HubSql`/`HubSqlPool`
 * convention: nothing under src/hub/ imports a concrete driver.
 */
export interface StripeBillingClient {
  prices: {
    list(params: {
      lookup_keys: string[]
      expand?: string[]
    }): Promise<{ data: Array<{ id: string; lookup_key?: string | null }> }>
  }
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ url: string | null }>
    }
  }
  billingPortal: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ url: string | null }>
    }
  }
}

/** One line item as it appears on a Stripe Subscription's `items.data[]` — the full `price`
 * object (including `lookup_key`) is embedded by Stripe on every subscription item by default,
 * so no `expand` is required to read it. */
export interface StripeSubscriptionItemLike {
  quantity?: number | null
  current_period_end?: number | null
  price: { lookup_key?: string | null } | null
}

/** The minimal shape of a Stripe Subscription `syncSubscriptionFromStripe` needs — whether it
 * arrived via `customer.subscription.*` (the event's `data.object` already has this shape) or was
 * fetched with `stripe.subscriptions.retrieve` after a `checkout.session.completed` event. */
export interface StripeSubscriptionLike {
  id: string
  /** A bare id string on every webhook payload; the real Stripe SDK's `Subscription.customer`
   * widens to `string | Customer | DeletedCustomer` because `stripe.subscriptions.retrieve` can
   * be asked to expand it — this module never does, but the type has to accept both shapes to
   * structurally match the real SDK. See `customerId()` below. */
  customer: string | { id: string }
  status: string
  metadata?: Record<string, string> | null
  items: { data: StripeSubscriptionItemLike[] }
}

export interface CreateCheckoutSessionParams {
  orgId: string
  lookupKey: string
  /** Defaults to 1. Multiplies the resolved price's quantity — it can never change which price
   * or what it costs per unit. */
  quantity?: number
  successUrl?: string
  cancelUrl?: string
}

export interface CreatePortalSessionParams {
  orgId: string
  returnUrl?: string
}

/**
 * Creates a Stripe Checkout Session for one line item, resolved by lookup key.
 *
 * `params.lookupKey` is validated against the fixed `LOOKUP_KEYS` set before Stripe is ever
 * called — an unknown key is a `ValidationError` (400 via the hub's shared error handler), not
 * a 500, and never reaches the Stripe API. The resolved Stripe price id is the ONLY pricing
 * information that reaches `stripe.checkout.sessions.create`; nothing from `params` beyond the
 * validated `lookupKey` and a sanitized `quantity` can affect what the customer is charged.
 */
export async function createCheckoutSession(
  sql: HubSqlPool,
  stripe: StripeBillingClient,
  params: CreateCheckoutSessionParams,
): Promise<{ url: string }> {
  if (!LOOKUP_KEYS.has(params.lookupKey)) {
    throw new ValidationError(`unknown price lookup key: ${params.lookupKey || '(missing)'}`)
  }
  const quantity = normalizeQuantity(params.quantity)

  const prices = await stripe.prices.list({ lookup_keys: [params.lookupKey], expand: ['data.product'] })
  const price = prices.data[0]
  if (!price) {
    // The catalogue is provisioned with every key in LOOKUP_KEYS in both test and live mode
    // (see the task brief) — reaching here means the deployed catalogue is missing a price
    // this code believes is valid. That is an ops/config problem, not a bad request, so it
    // is NOT a ValidationError.
    throw new Error(`stripe catalogue is missing a price for lookup key: ${params.lookupKey}`)
  }

  const existingCustomerId = await lookupStripeCustomerId(sql, params.orgId)

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: price.id, quantity }],
    client_reference_id: params.orgId,
    metadata: { orgId: params.orgId },
    subscription_data: { metadata: { orgId: params.orgId } },
    ...(existingCustomerId ? { customer: existingCustomerId } : {}),
    success_url: params.successUrl ?? 'https://app.orchestraboard.dev/billing?checkout=success',
    cancel_url: params.cancelUrl ?? 'https://app.orchestraboard.dev/billing?checkout=cancelled',
  })

  if (!session.url) throw new Error('stripe did not return a checkout session url')
  return { url: session.url }
}

/**
 * Creates a Stripe Billing Portal session for an org's existing Stripe customer. An org that
 * has never completed checkout has no `stripe_customer_id` cached yet — that is a
 * `ValidationError` (400), not a 500: it is a legitimate, expected request state, not a server
 * fault.
 */
export async function createPortalSession(
  sql: HubSqlPool,
  stripe: StripeBillingClient,
  params: CreatePortalSessionParams,
): Promise<{ url: string }> {
  const customerId = await lookupStripeCustomerId(sql, params.orgId)
  if (!customerId) {
    throw new ValidationError('org has no Stripe customer yet; complete checkout before opening the billing portal')
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: params.returnUrl ?? 'https://app.orchestraboard.dev/billing',
  })

  if (!session.url) throw new Error('stripe did not return a billing portal session url')
  return { url: session.url }
}

/**
 * Applies one Stripe subscription's current state to `subscriptions` (and mirrors active/
 * suspended onto `orgs.status`, which is what Task 6's `assertOrgWritable` reads). Called from
 * the webhook for `checkout.session.completed` (after fetching the subscription it points at),
 * `customer.subscription.updated`, and `customer.subscription.deleted`.
 *
 * Naturally idempotent, the same way Task 4's Clerk webhook is: this is an upsert keyed on
 * `subscriptions.org_id` that always writes the subscription's current state, so replaying the
 * same event (or receiving `updated` after `deleted` out of order — Stripe does not guarantee
 * delivery order) converges to the same row rather than needing a separate "already processed
 * this event id" ledger.
 *
 * Quantities are derived from `subscription.items.data`, never from a single top-level
 * quantity field — the subscription is multi-line (base + extra seats + agent packs + optional
 * SSO), so any single quantity would be wrong.
 */
export async function syncSubscriptionFromStripe(sql: HubSqlPool, subscription: StripeSubscriptionLike): Promise<void> {
  const orgId = await resolveOrgIdForSubscription(sql, subscription)
  if (!orgId) {
    // No org in the mirror claims this subscription (by metadata.orgId or by a previously
    // cached stripe_customer_id) — most likely a subscription that belongs to a different
    // integration on the same Stripe account, or a race where the org's checkout session
    // metadata hasn't been read yet. Silently accepted rather than thrown: throwing would make
    // Stripe retry forever for a subscription this hub will never own.
    return
  }

  const { seatsIncluded, seatsPurchased, agentPacks, ssoEnabled } = deriveQuantities(subscription.items.data)
  const periodEnd = maxCurrentPeriodEnd(subscription.items.data)
  const orgActive = subscription.status === 'active' || subscription.status === 'trialing'
  const customerId = resolveCustomerId(subscription.customer)

  await sql.query(
    `INSERT INTO subscriptions
       (org_id, stripe_customer_id, stripe_subscription_id, status, current_period_end,
        seats_included, seats_purchased, agent_packs, sso_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (org_id) DO UPDATE SET
       stripe_customer_id     = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       status                 = excluded.status,
       current_period_end     = excluded.current_period_end,
       seats_included         = excluded.seats_included,
       seats_purchased        = excluded.seats_purchased,
       agent_packs            = excluded.agent_packs,
       sso_enabled            = excluded.sso_enabled,
       updated_at             = now()`,
    [
      orgId, customerId, subscription.id, subscription.status, periodEnd,
      seatsIncluded, seatsPurchased, agentPacks, ssoEnabled,
    ],
  )

  await sql.query('UPDATE orgs SET status = $1 WHERE id = $2', [orgActive ? 'active' : 'suspended', orgId])
}

function normalizeQuantity(raw: number | undefined): number {
  if (raw === undefined) return 1
  if (!Number.isInteger(raw) || raw < 1) {
    throw new ValidationError('quantity must be a positive integer')
  }
  return raw
}

async function lookupStripeCustomerId(sql: HubSqlPool, orgId: string): Promise<string | null> {
  const result = await sql.query<{ stripe_customer_id: string | null }>(
    'SELECT stripe_customer_id FROM subscriptions WHERE org_id = $1', [orgId],
  )
  return result.rows[0]?.stripe_customer_id ?? null
}

/**
 * Prefers `subscription.metadata.orgId` (set by `createCheckoutSession`'s `subscription_data`
 * at creation time, and retained by Stripe across subsequent updates unless explicitly
 * cleared). Falls back to the org already on file for this Stripe customer — needed for a
 * `customer.subscription.updated`/`.deleted` event on a subscription this hub created before
 * metadata existed, or one whose metadata was stripped by a dashboard edit.
 */
async function resolveOrgIdForSubscription(sql: HubSqlPool, subscription: StripeSubscriptionLike): Promise<string | null> {
  const metaOrgId = subscription.metadata?.orgId
  if (metaOrgId) {
    const org = await sql.query<{ id: string }>('SELECT id FROM orgs WHERE id = $1', [metaOrgId])
    if (org.rows[0]) return metaOrgId
  }

  const bySubscription = await sql.query<{ org_id: string }>(
    'SELECT org_id FROM subscriptions WHERE stripe_subscription_id = $1', [subscription.id],
  )
  if (bySubscription.rows[0]) return bySubscription.rows[0].org_id

  const byCustomer = await sql.query<{ org_id: string }>(
    'SELECT org_id FROM subscriptions WHERE stripe_customer_id = $1', [resolveCustomerId(subscription.customer)],
  )
  return byCustomer.rows[0]?.org_id ?? null
}

function resolveCustomerId(customer: string | { id: string }): string {
  return typeof customer === 'string' ? customer : customer.id
}

interface DerivedQuantities {
  seatsIncluded: number
  seatsPurchased: number
  agentPacks: number
  ssoEnabled: boolean
}

/**
 * The Cloud track's base line (`cloud_base_*`) always grants a fixed 3 included seats — it is
 * not a per-unit quantity. The Business track (`business_seat_*`) has no separate base line at
 * all (a 10-seat minimum is enforced by Stripe's price, not modeled here); every Business seat
 * purchased is, functionally, just another seat, so it folds into `seatsPurchased` alongside
 * `cloud_seat_*` rather than needing its own cached column. This is a scope decision the brief
 * left ambiguous — see the task report.
 */
function deriveQuantities(items: StripeSubscriptionItemLike[]): DerivedQuantities {
  let seatsIncluded = 0
  let seatsPurchased = 0
  let agentPacks = 0
  let ssoEnabled = false

  for (const item of items) {
    const key = item.price?.lookup_key
    if (!key) continue
    const quantity = item.quantity ?? 0

    switch (key) {
      case 'cloud_base_monthly':
      case 'cloud_base_yearly':
        seatsIncluded = 3
        break
      case 'cloud_seat_monthly':
      case 'cloud_seat_yearly':
      case 'business_seat_monthly':
      case 'business_seat_yearly':
        seatsPurchased += quantity
        break
      case 'cloud_agent_pack_monthly':
      case 'cloud_agent_pack_yearly':
        agentPacks += quantity
        break
      case 'cloud_sso_monthly':
      case 'cloud_sso_yearly':
        ssoEnabled = true
        break
      default:
        // Not one of this task's ten lookup keys — ignored rather than thrown, the same
        // "unhandled but acknowledged" stance the Clerk webhook takes for event types it
        // doesn't mirror.
        break
    }
  }

  return { seatsIncluded, seatsPurchased, agentPacks, ssoEnabled }
}

/** Stripe items on one subscription normally share a billing cycle, so their
 * `current_period_end` values are normally identical; `max` is a defensive choice for the rare
 * case an item was added mid-cycle with its own aligned period, so cached access never expires
 * earlier than what the customer is actually paid through. */
function maxCurrentPeriodEnd(items: StripeSubscriptionItemLike[]): Date | null {
  let max: number | null = null
  for (const item of items) {
    if (typeof item.current_period_end !== 'number') continue
    if (max === null || item.current_period_end > max) max = item.current_period_end
  }
  return max === null ? null : new Date(max * 1000)
}
