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
  /** The web app's origin (e.g. `https://app.example.com` — scheme + host, no trailing slash),
   * used to build `success_url`/`cancel_url`. Typed optional because callers thread it straight
   * through from `HubServerOptions#webOrigin` (itself optional), but `createCheckoutSession`
   * requires it at runtime — see `requireWebOrigin` below. */
  webOrigin?: string
}

export interface CreatePortalSessionParams {
  orgId: string
  /** Same contract as `CreateCheckoutSessionParams#webOrigin` — builds `return_url`. */
  webOrigin?: string
}

/**
 * `webOrigin` is the same value CORS is scoped to (`src/hub/cors.ts`, from `WEB_ORIGIN` via
 * `HubEnv`/`HubServerOptions`) — the browser's real, already-verified origin, not a guess.
 * Throws a plain `Error` (not `ValidationError`): a missing `WEB_ORIGIN` is an ops/config
 * problem, not a bad request from whoever clicked the button — same stance as "stripe catalogue
 * is missing a price" below. This fails loudly and immediately, before any Stripe call: a
 * hardcoded fallback domain would still create a real, live-mode-capable Checkout/Portal session
 * and only surface as a broken redirect after the customer had already paid — silent then, not
 * loud now. Refusing outright is the fix.
 */
function requireWebOrigin(webOrigin: string | undefined): string {
  if (!webOrigin) {
    throw new Error(
      'WEB_ORIGIN must be configured to build checkout/portal redirect URLs — refusing to guess one',
    )
  }
  return webOrigin
}

/** `'none'` means the subscription's items contained no lookup key this hub recognizes yet —
 * see `deriveQuantities`'s handling of that case. */
export type SubscriptionTier = 'cloud' | 'business' | 'none'

/** Where `syncSubscriptionFromStripe` reports conditions worth a human's attention — a mixed-
 * tier subscription, or one with no recognized lookup key. Defaults to `console.warn`; the
 * webhook plugin passes an adapter over `request.log` so these land in the same structured
 * request-scoped logs as everything else Fastify logs. */
export interface SyncLogger {
  warn(message: string, meta?: Record<string, unknown>): void
}

const consoleSyncLogger: SyncLogger = {
  warn: (message, meta) => console.warn(message, meta ?? {}),
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
  const webOrigin = requireWebOrigin(params.webOrigin)
  await refuseSecondSubscription(sql, params.orgId)

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
    success_url: `${webOrigin}/billing?checkout=success`,
    cancel_url: `${webOrigin}/billing?checkout=cancelled`,
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
  const webOrigin = requireWebOrigin(params.webOrigin)

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${webOrigin}/billing`,
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
export async function syncSubscriptionFromStripe(
  sql: HubSqlPool, subscription: StripeSubscriptionLike, logger: SyncLogger = consoleSyncLogger,
): Promise<void> {
  const orgId = await resolveOrgIdForSubscription(sql, subscription)
  if (!orgId) {
    // No org in the mirror claims this subscription (by metadata.orgId or by a previously
    // cached stripe_customer_id) — most likely a subscription that belongs to a different
    // integration on the same Stripe account, or a race where the org's checkout session
    // metadata hasn't been read yet. Silently accepted rather than thrown: throwing would make
    // Stripe retry forever for a subscription this hub will never own.
    return
  }

  const quantities = deriveQuantities(subscription.items.data, logger, subscription.id)
  const periodEnd = maxCurrentPeriodEnd(subscription.items.data)
  // See `SUSPENDING_SUBSCRIPTION_STATUS`: writable is the default and only the terminal statuses
  // suspend, so a `past_due` customer Stripe is still retrying keeps working.
  const orgActive = !subscriptionSuspendsOrg(subscription.status)
  const customerId = resolveCustomerId(subscription.customer)

  if (quantities.tier === 'none') {
    // Deliberately does NOT touch seats_included/seats_purchased/agent_packs/sso_enabled on an
    // existing row (see deriveQuantities' logged warning above). A subscription with no lookup
    // key this hub recognizes is a data quirk — catalogue drift, a lookup_key typo, or a price
    // created outside this task's ten keys — not evidence the org bought nothing. Overwriting
    // real cached entitlements with zeros here would silently lock a paying org out of its own
    // board on the next routine resync of an otherwise-healthy subscription; a wrong suspension
    // is worse for a customer than briefly stale (but still correct) cached quantities. A
    // brand-new row (never synced before) has nothing to preserve, so it gets the schema's
    // conservative defaults (0/false) — there is genuinely no signal yet for this org.
    await sql.query(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, tier, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (org_id) DO UPDATE SET
         stripe_customer_id     = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         status                 = excluded.status,
         current_period_end     = excluded.current_period_end,
         tier                   = excluded.tier,
         updated_at             = now()`,
      [orgId, customerId, subscription.id, subscription.status, periodEnd, quantities.tier],
    )
  } else {
    await sql.query(
      `INSERT INTO subscriptions
         (org_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, tier,
          seats_included, seats_purchased, agent_packs, sso_enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (org_id) DO UPDATE SET
         stripe_customer_id     = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         status                 = excluded.status,
         current_period_end     = excluded.current_period_end,
         tier                   = excluded.tier,
         seats_included         = excluded.seats_included,
         seats_purchased        = excluded.seats_purchased,
         agent_packs            = excluded.agent_packs,
         sso_enabled            = excluded.sso_enabled,
         updated_at             = now()`,
      [
        orgId, customerId, subscription.id, subscription.status, periodEnd, quantities.tier,
        quantities.seatsIncluded, quantities.seatsPurchased, quantities.agentPacks, quantities.ssoEnabled,
      ],
    )
  }

  await sql.query('UPDATE orgs SET status = $1 WHERE id = $2', [orgActive ? 'active' : 'suspended', orgId])
}

/**
 * Statuses that mean this org's subscription is not paying for anything any more, so
 * `orgs.status` goes to `'suspended'` and writes stop.
 *
 * Everything NOT listed here stays writable — including `past_due` and `incomplete`, which
 * is the point. Stripe sets `past_due` on the FIRST failed charge and then smart-retries
 * for two to three weeks; treating only `active`/`trialing` as good (as this did) suspended
 * a real, paying customer mid-dunning over one declined card, before Stripe had even given
 * up. `incomplete` is the same shape at the other end of the lifecycle: the first payment
 * hasn't confirmed yet (SCA, say), not that it failed.
 *
 * `incomplete_expired` and `paused` join `canceled`/`unpaid` because in all four Stripe has
 * stopped trying and no money is flowing. An unrecognized status is deliberately treated as
 * writable: a wrong suspension of a paying customer is worse than a generous window on a
 * status this code has never seen, the same asymmetry `syncSubscriptionFromStripe` already
 * applies to an unrecognized tier.
 */
const SUSPENDING_SUBSCRIPTION_STATUS = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused'])

/** Exported for the entitlement/webhook tests, and so nothing has to re-list these strings. */
export function subscriptionSuspendsOrg(status: string): boolean {
  return SUSPENDING_SUBSCRIPTION_STATUS.has(status)
}

/**
 * The statuses after which no Stripe subscription object remains that a new checkout could
 * collide with — Stripe cannot revive either one, so the org is free to subscribe again.
 *
 * This is a DIFFERENT question from `subscriptionSuspendsOrg`, and the first version of this
 * fix wrongly asked that one instead. "Should this org be suspended?" is true whenever no
 * money is flowing, which includes `unpaid` and `paused` — but a subscription in either of
 * those states still EXISTS and can resume (a retried invoice succeeding, a pause window
 * ending), so a second checkout against it recreates exactly the double-billing and
 * entitlement-destruction this guard exists to prevent. Suspension is about money; this is
 * about object lifetime, and only `canceled` and `incomplete_expired` are terminal.
 *
 * `incomplete` is deliberately NOT here: an abandoned SCA challenge can still be completed by
 * the customer until Stripe expires it (~23h), at which point it becomes `incomplete_expired`
 * and this set lets the retry through. Refusing for that window is the money-safe side of the
 * trade — the alternative is two live subscriptions if the customer finishes the first
 * payment after starting a second checkout.
 */
const TERMINAL_SUBSCRIPTION_STATUS = new Set(['canceled', 'incomplete_expired'])

/**
 * Refuses a checkout for an org that already has a live subscription, pointing the caller at
 * the billing portal instead.
 *
 * The UI is not allowed to be the only thing enforcing this. `subscriptions.org_id` is a
 * PRIMARY KEY, so a second Stripe subscription against the same customer would sync onto the
 * SAME row: the second (base-only) subscription's quantities overwrite the first's, and every
 * extra seat and agent pack the customer already paid for silently becomes 0. Cancelling
 * either one then suspends the org while the other keeps billing. This is a `ValidationError`
 * (400) rather than a 500 — it is an expected request state with an obvious next action.
 *
 * `stripe_subscription_id IS NOT NULL` is part of the test on purpose: a `subscriptions` row
 * can exist with only a cached `stripe_customer_id` (schema default status `'inactive'`, no
 * subscription ever completed), and that org must still be able to check out.
 *
 * Reads `TERMINAL_SUBSCRIPTION_STATUS`, never `subscriptionSuspendsOrg` — see that constant's
 * comment for why suspension is the wrong question here.
 */
async function refuseSecondSubscription(sql: HubSqlPool, orgId: string): Promise<void> {
  const result = await sql.query<{ status: string; stripe_subscription_id: string | null }>(
    'SELECT status, stripe_subscription_id FROM subscriptions WHERE org_id = $1', [orgId],
  )
  const row = result.rows[0]
  if (!row?.stripe_subscription_id) return
  if (TERMINAL_SUBSCRIPTION_STATUS.has(row.status)) return

  // Deliberately not worded "already has an ACTIVE subscription": this also refuses `unpaid`
  // and `paused`, where the subscription exists and can resume but is not active.
  throw new ValidationError(
    'this org already has a subscription — use the billing portal to change your plan, seats, '
    + 'or payment method, or to cancel it before starting a new one. Starting a second checkout '
    + 'would create a second subscription against the same customer and overwrite the '
    + 'entitlements you have already paid for.',
  )
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
  tier: SubscriptionTier
  seatsIncluded: number
  seatsPurchased: number
  agentPacks: number
  ssoEnabled: boolean
}

/** The four Cloud-track lookup keys (`cloud_base` is its own case below, but still belongs to
 * this family for tier-detection purposes). */
const CLOUD_LOOKUP_KEYS = new Set([
  'cloud_base_monthly', 'cloud_base_yearly',
  'cloud_seat_monthly', 'cloud_seat_yearly',
  'cloud_agent_pack_monthly', 'cloud_agent_pack_yearly',
  'cloud_sso_monthly', 'cloud_sso_yearly',
])
const BUSINESS_LOOKUP_KEYS = new Set(['business_seat_monthly', 'business_seat_yearly'])

/**
 * The Cloud track's base line (`cloud_base_*`) always grants a fixed 3 included seats — it is
 * not a per-unit quantity. The Business track (`business_seat_*`) has no separate base line at
 * all (a 10-seat minimum is enforced by Stripe's price, not modeled here); every Business seat
 * purchased is, functionally, just another seat, so it folds into `seatsPurchased` alongside
 * `cloud_seat_*`. Tier identity is tracked SEPARATELY (`tier`), specifically so Task 6 never has
 * to reconstruct it from `seats_included === 0` — that heuristic is ambiguous between a
 * legitimate Business org and a Cloud checkout missing its base line.
 *
 * Two deliberately-handled edge cases:
 *   - Both families present on one subscription (checkout doesn't prevent selling a
 *     `business_seat_*` line to an org that already has `cloud_base_*`, or vice versa via two
 *     separate checkouts over time): resolved to `'cloud'` — a subscription with a `cloud_base`
 *     line is unambiguously Cloud regardless of what else got attached — and logged loudly, since
 *     this should never happen from this hub's own checkout flow and signals either a manual
 *     Stripe dashboard edit or a bug upstream of this function.
 *   - Neither family present (no item's lookup key matches any of the ten this task defines):
 *     resolved to `'none'`. The caller (`syncSubscriptionFromStripe`) does NOT overwrite
 *     previously cached seat/pack/SSO numbers in this case — see its own comment.
 */
function deriveQuantities(items: StripeSubscriptionItemLike[], logger: SyncLogger, subscriptionId: string): DerivedQuantities {
  let seatsIncluded = 0
  let seatsPurchased = 0
  let agentPacks = 0
  let ssoEnabled = false
  let cloudPresent = false
  let businessPresent = false

  for (const item of items) {
    const key = item.price?.lookup_key
    if (!key) continue
    const quantity = item.quantity ?? 0
    if (CLOUD_LOOKUP_KEYS.has(key)) cloudPresent = true
    if (BUSINESS_LOOKUP_KEYS.has(key)) businessPresent = true

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

  let tier: SubscriptionTier
  if (cloudPresent && businessPresent) {
    tier = 'cloud'
    logger.warn(
      'stripe subscription has both Cloud and Business lookup keys; resolving to Cloud tier deterministically',
      { subscriptionId },
    )
  } else if (cloudPresent) {
    tier = 'cloud'
  } else if (businessPresent) {
    tier = 'business'
  } else {
    tier = 'none'
    logger.warn(
      'stripe subscription has no recognized Cloud or Business lookup key; leaving cached entitlement quantities unchanged',
      { subscriptionId },
    )
  }

  return { tier, seatsIncluded, seatsPurchased, agentPacks, ssoEnabled }
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
