import { ForbiddenError, NotFoundError } from './errors.js'
import type { HubSql } from './sql.js'

/**
 * Cloud track (see migration 005): a base subscription always includes 3 seats;
 * extra seats and agent packs are purchased individually.
 */
const CLOUD_BASE_SEATS = 3
const CLOUD_AGENTS_PER_SEAT = 3
const AGENTS_PER_PACK = 10

/** Business track: no included base seats, purchased seats only, Stripe's price
 * enforces a 10-seat minimum on checkout — `Math.max` below is a defensive mirror
 * of that price-level constraint, not a substitute for it. */
const BUSINESS_SEAT_MINIMUM = 10

/**
 * `assertAgentCapacity`/`entitlementsFor` never cache a member count (see the task
 * brief) — this is computed live. Nothing here reads Stripe: every number comes from
 * `subscriptions`, which is populated only by `syncSubscriptionFromStripe` off a
 * verified webhook (see billing.ts). Billing must never be on the request path, and
 * Stripe being down must never stop a paying team from working.
 */
export interface EntitlementSnapshot {
  /** Seats this org is entitled to. Never a live membership count — compare against
   * `COUNT(memberships)`, computed by the caller, to know how many are in use. */
  seats: number
  /** Concurrent (non-offline) agents this org may run at once. */
  concurrentAgents: number
  sso: boolean
  /** `orgs.status` ('active' | 'suspended') — the same field `assertOrgWritable` reads. */
  status: string
}

/** `EntitlementSnapshot` plus the tier that produced it — kept internal (not part of
 * the exported interface, which the task brief specifies without a `tier` field) but
 * needed by `assertAgentCapacity` to phrase a tier-aware error, and by
 * `GET /entitlements` (server.ts) for its "current plan" display. */
interface EntitlementDetail extends EntitlementSnapshot {
  tier: 'cloud' | 'business' | 'none'
}

interface SubscriptionRow {
  tier: 'cloud' | 'business' | 'none'
  seats_included: number
  seats_purchased: number
  agent_packs: number
  sso_enabled: boolean
}

/**
 * Derives an org's current entitlement purely from cached columns (`orgs.status`,
 * `orgs.seat_cap`, `subscriptions.*`) — never a live Stripe call.
 *
 * Tier handling:
 *   - **cloud**: seats = 3 (base) + `seats_purchased`; concurrent agents =
 *     3 × seats + 10 × `agent_packs`.
 *   - **business**: seats = `seats_purchased`, floored at the 10-seat minimum Stripe's
 *     price already enforces at checkout. Business has no defined agent-pack or SSO
 *     product today (see migration 005's comment and Task 5's report — Business
 *     subscriptions never carry an agent-pack or SSO lookup key, so those columns
 *     stay at their schema defaults for a real Business org). Rather than invent an
 *     unbounded agent allowance — which would undercut Cloud's agent-pack pricing
 *     for zero extra revenue — concurrent agents uses the *same* 3-per-seat ratio as
 *     Cloud's included agents, so the platform has one legible mental model
 *     ("3 agents per seat") instead of two. `sso` passes the cached column straight
 *     through either way, so a future Business SSO price works without a code change.
 *   - **none**: a subscription with no lookup key this hub recognizes (see
 *     `deriveQuantities` in billing.ts) is NEVER zero entitlement — Task 5's webhook
 *     sync deliberately preserves an existing org's cached seat/pack numbers through
 *     a resync that lands on an unrecognized price, specifically so Task 6 doesn't
 *     have to treat 'none' as "nothing was ever bought". If real cached values
 *     survived a prior healthy sync, this honors them with the Cloud formula (the
 *     numbers were populated while a real tier was known; re-deriving which track
 *     they came from is not worth it when the safe answer is "keep serving what was
 *     already granted"). Only when there is truly no signal — no subscriptions row
 *     at all, or a brand-new row that was never synced (schema defaults of 0/false)
 *     — does this fall back to `orgs.seat_cap` (default 5, the pre-Stripe column
 *     Task 4's Clerk webhook already compares membership count against) as a
 *     conservative, legible default: never zero (an org is never locked out of its
 *     own board over a Stripe data quirk), never unlimited (a never-paying org isn't
 *     handed Cloud-base-tier capacity for free), and easy to explain to support.
 */
async function resolveEntitlement(sql: HubSql, orgId: string): Promise<EntitlementDetail> {
  const orgResult = await sql.query<{ status: string; seat_cap: number }>(
    'SELECT status, seat_cap FROM orgs WHERE id = $1', [orgId],
  )
  const org = orgResult.rows[0]
  const status = org?.status ?? 'active'
  const fallbackSeats = org?.seat_cap ?? 5

  const subResult = await sql.query<SubscriptionRow>(
    'SELECT tier, seats_included, seats_purchased, agent_packs, sso_enabled FROM subscriptions WHERE org_id = $1',
    [orgId],
  )
  const sub = subResult.rows[0]

  if (sub?.tier === 'business') {
    const seats = Math.max(sub.seats_purchased, BUSINESS_SEAT_MINIMUM)
    return { tier: 'business', seats, concurrentAgents: CLOUD_AGENTS_PER_SEAT * seats, sso: sub.sso_enabled, status }
  }

  if (sub?.tier === 'cloud') {
    const seats = CLOUD_BASE_SEATS + sub.seats_purchased
    const concurrentAgents = CLOUD_AGENTS_PER_SEAT * seats + AGENTS_PER_PACK * sub.agent_packs
    return { tier: 'cloud', seats, concurrentAgents, sso: sub.sso_enabled, status }
  }

  // sub is undefined, or sub.tier === 'none' — see the doc comment above.
  const cachedSeats = sub ? sub.seats_included + sub.seats_purchased : 0
  if (cachedSeats > 0) {
    const concurrentAgents = CLOUD_AGENTS_PER_SEAT * cachedSeats + AGENTS_PER_PACK * (sub?.agent_packs ?? 0)
    return { tier: 'none', seats: cachedSeats, concurrentAgents, sso: sub?.sso_enabled ?? false, status }
  }
  return {
    tier: 'none', seats: fallbackSeats, concurrentAgents: CLOUD_AGENTS_PER_SEAT * fallbackSeats,
    sso: false, status,
  }
}

/** Public entry point — see `resolveEntitlement`'s doc comment for the derivation
 * rules. `tier` is deliberately omitted from the return shape (kept narrow to what
 * the task brief specifies); callers that need it use `resolveEntitlement` directly
 * within this module, or read the `tier` field `GET /entitlements` (server.ts)
 * exposes over HTTP. */
export async function entitlementsFor(sql: HubSql, orgId: string): Promise<EntitlementSnapshot> {
  const { tier: _tier, ...snapshot } = await resolveEntitlement(sql, orgId)
  return snapshot
}

/**
 * Throws `ForbiddenError` when an org may not write — either because it never subscribed,
 * or because its subscription lapsed.
 *
 * Reads never call this, so both refusals still serve every GET route, and the billing
 * routes are deliberately outside it too: an org has to be able to load its billing page
 * and reach checkout/portal in order to fix the reason it was refused. Nobody's data is
 * held hostage; nothing new can be written until it's resolved.
 *
 * **Never-subscribed is not the `'none'` tier case.** An org whose `subscriptions` row
 * exists but whose tier this hub doesn't recognize keeps its cached entitlements and keeps
 * writing (see `resolveEntitlement`) — wrongly suspending a paying customer over catalogue
 * drift is worse than a generous limit. An org with NO row has never paid at all, and until
 * this check existed, not paying was strictly better than paying: `resolveEntitlement`'s
 * `orgs.seat_cap` fallback handed it 5 seats and 15 concurrent agents, permanently, against
 * the 3 seats and 9 agents Cloud's $20/mo base tier buys. Row existence is the whole test —
 * it is written only by `syncSubscriptionFromStripe` off a verified Stripe webhook.
 */
export async function assertOrgWritable(sql: HubSql, orgId: string): Promise<void> {
  const result = await sql.query<{ status: string; has_subscription: boolean }>(
    `SELECT o.status, (s.org_id IS NOT NULL) AS has_subscription
     FROM orgs o LEFT JOIN subscriptions s ON s.org_id = o.id
     WHERE o.id = $1`,
    [orgId],
  )
  const row = result.rows[0]
  if (row && !row.has_subscription) {
    throw new ForbiddenError(
      'this org has no subscription — writes are disabled until one is started. Open the billing '
      + 'page and complete checkout to enable them (reads and billing still work).',
    )
  }
  if (row?.status === 'suspended') {
    throw new ForbiddenError(
      'this org\'s subscription is suspended — writes are disabled until billing is restored (reads still work)',
    )
  }
}

/**
 * Throws `ForbiddenError` when the org is already running its entitled number of
 * concurrent agents — i.e. one more registration would exceed the cap. An org
 * currently AT its cap is otherwise unaffected: existing agents keep heartbeating,
 * and this only blocks the registration that would push the count over.
 *
 * "Concurrent" is agents not in the `offline` state — `sweepStalePresence` (see
 * presence.ts) is what flips a lapsed agent to `offline`, freeing its slot.
 *
 * Deliberately NOT called from the ops endpoint's `agent.register` dispatch —
 * `registerAgent` (presence.ts) is idempotent by (org, board, name): a daemon
 * reconnecting under a name it already registered must not be refused just because
 * the org happens to be at capacity, since that call adds no new agent. This is
 * called from inside `registerAgent`'s transaction, after its existing-row check has
 * already short-circuited AND after that transaction has locked the org row (see
 * `registerAgent`'s own comment on the `SELECT ... FOR UPDATE`), so only a genuinely
 * new agent is ever weighed against the cap, and two concurrent registrations for
 * two different new names cannot both read "under cap" and both commit.
 */
export async function assertAgentCapacity(sql: HubSql, orgId: string): Promise<void> {
  const entitlement = await resolveEntitlement(sql, orgId)
  const result = await sql.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM agents WHERE org_id = $1 AND state <> 'offline'",
    [orgId],
  )
  const liveAgents = Number(result.rows[0]?.n ?? 0)
  if (liveAgents >= entitlement.concurrentAgents) {
    throw new ForbiddenError(
      `agent capacity reached: ${liveAgents}/${entitlement.concurrentAgents} concurrent agents in use — `
      + `${capacityRemedy(entitlement.tier)}`,
    )
  }
}

/** Tier-aware remedy text for `assertAgentCapacity`'s error — Business has no
 * defined agent-pack product (see `resolveEntitlement`'s doc comment), so telling a
 * Business org to "buy an agent pack" would point at something that doesn't exist
 * for them. `'none'` orgs aren't on a recognized paid plan at all, so the actionable
 * step is subscribing, not adding seats to a plan they don't have. */
function capacityRemedy(tier: 'cloud' | 'business' | 'none'): string {
  switch (tier) {
    case 'cloud': return 'buy an agent pack (+10 concurrent agents) or add seats to register more'
    case 'business': return 'add seats to register more concurrent agents'
    case 'none': return 'upgrade to a paid Cloud or Business plan to raise this limit'
  }
}

/**
 * Throws `ForbiddenError` when minting a new device token for `membershipId` would
 * exceed the org's entitled seats. Ranking is by `memberships.created_at` (ties
 * broken by `id` for a fully deterministic order) — the first N members, in join
 * order, may connect a daemon; members beyond that get a clear refusal rather than a
 * silent failure. This is deliberately the ONLY seat-cap enforcement point: an
 * over-cap member is never retroactively locked out of an org they're already in
 * (Clerk remains the source of truth for membership — see webhooks/clerk.ts, which
 * accepts an over-cap membership rather than rejecting it) and an already-minted
 * device keeps working even if the org later drops below its member's rank — this
 * only gates the next NEW device pairing. A seat's real cost to this system is a
 * connected daemon, which is exactly what this meters; everyone can still sign in
 * and view the board regardless of rank.
 *
 * A no-op when `membershipId` is not given (a device with no member behind it —
 * every existing caller/test that mints a token this way predates this check and
 * has no membership to rank).
 */
export async function assertSeatAvailable(sql: HubSql, orgId: string, membershipId: string): Promise<void> {
  const ranked = await sql.query<{ rn: string }>(
    `WITH ranked AS (
       SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
       FROM memberships WHERE org_id = $1
     )
     SELECT rn::text AS rn FROM ranked WHERE id = $2`,
    [orgId, membershipId],
  )
  const rank = ranked.rows[0]?.rn
  if (rank === undefined) throw new NotFoundError('membership not found in this org')

  const entitlement = await entitlementsFor(sql, orgId)
  if (Number(rank) > entitlement.seats) {
    throw new ForbiddenError(
      `seat cap reached: this org is entitled to ${entitlement.seats} seat(s) and you are member #${rank} `
      + 'by join order — buy more seats to connect a daemon (you can still sign in and view the board)',
    )
  }
}
