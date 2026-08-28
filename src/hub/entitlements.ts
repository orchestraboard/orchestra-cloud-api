import { ForbiddenError } from './errors.js'
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
export async function entitlementsFor(sql: HubSql, orgId: string): Promise<EntitlementSnapshot> {
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
    return { seats, concurrentAgents: CLOUD_AGENTS_PER_SEAT * seats, sso: sub.sso_enabled, status }
  }

  if (sub?.tier === 'cloud') {
    const seats = CLOUD_BASE_SEATS + sub.seats_purchased
    const concurrentAgents = CLOUD_AGENTS_PER_SEAT * seats + AGENTS_PER_PACK * sub.agent_packs
    return { seats, concurrentAgents, sso: sub.sso_enabled, status }
  }

  // sub is undefined, or sub.tier === 'none' — see the doc comment above.
  const cachedSeats = sub ? sub.seats_included + sub.seats_purchased : 0
  if (cachedSeats > 0) {
    const concurrentAgents = CLOUD_AGENTS_PER_SEAT * cachedSeats + AGENTS_PER_PACK * (sub?.agent_packs ?? 0)
    return { seats: cachedSeats, concurrentAgents, sso: sub?.sso_enabled ?? false, status }
  }
  return { seats: fallbackSeats, concurrentAgents: CLOUD_AGENTS_PER_SEAT * fallbackSeats, sso: false, status }
}

/**
 * Throws `ForbiddenError` when an org's billing has lapsed. Deliberately checks only
 * `orgs.status` — reads never call this, so a suspended org still serves every GET
 * route; only whatever calls this (the ops endpoint, for every op it accepts) is
 * blocked. Nobody's data is held hostage over a billing lapse, but nothing new can
 * be written until it's resolved.
 */
export async function assertOrgWritable(sql: HubSql, orgId: string): Promise<void> {
  const result = await sql.query<{ status: string }>('SELECT status FROM orgs WHERE id = $1', [orgId])
  if (result.rows[0]?.status === 'suspended') {
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
 * called from inside `registerAgent`, after its existing-row check has already
 * short-circuited, so only a genuinely new agent is ever weighed against the cap.
 */
export async function assertAgentCapacity(sql: HubSql, orgId: string): Promise<void> {
  const entitlement = await entitlementsFor(sql, orgId)
  const result = await sql.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM agents WHERE org_id = $1 AND state <> 'offline'",
    [orgId],
  )
  const liveAgents = Number(result.rows[0]?.n ?? 0)
  if (liveAgents >= entitlement.concurrentAgents) {
    throw new ForbiddenError(
      `agent capacity reached: ${liveAgents}/${entitlement.concurrentAgents} concurrent agents in use — `
      + 'buy an agent pack (+10 concurrent agents) or add seats to register more',
    )
  }
}
