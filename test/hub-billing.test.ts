import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createCheckoutSession, createPortalSession, syncSubscriptionFromStripe, type StripeBillingClient, type StripeSubscriptionLike, type SyncLogger } from '../src/hub/billing.js'
import { ValidationError } from '../src/hub/errors.js'
import { assertOrgWritable } from '../src/hub/entitlements.js'
import { buildHubServer } from '../src/hub/server.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import { hubTestSql, seedOrg, seedUser, seedMembership } from './support/hub-sql.js'

// The billing routes now require a Clerk principal (a device token can no longer reach
// them), so this file authenticates as one — mocked exactly the way test/hub-clerk-auth.test.ts
// does it, so no test here makes a network call or needs a real Clerk credential.
vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn() }))

import { verifyToken } from '@clerk/backend'
const verifyTokenMock = vi.mocked(verifyToken)

const CLERK_SECRET = 'sk_test_billing_secret'

/** `clerk_valid.<clerkUserId>.<clerkOrgId|'none'>` — anything else is a bad signature. */
function fakeClerkToken(clerkUserId: string, clerkOrgId: string | null): string {
  return `clerk_valid.${clerkUserId}.${clerkOrgId ?? 'none'}`
}

verifyTokenMock.mockImplementation(async (token: string) => {
  const match = /^clerk_valid\.([^.]+)\.([^.]+)$/.exec(token)
  if (!match) throw new Error('mock: bad signature')
  const [, sub, org] = match
  return {
    __raw: token, iss: 'https://example.clerk.accounts.dev', sub, sid: 'sess_fixture',
    nbf: 0, iat: 0, exp: Math.floor(Date.now() / 1000) + 3600,
    org_id: org === 'none' ? undefined : org,
  } as any
})

/** A stand-in `WEB_ORIGIN` value — real tests of `webOrigin`'s absence live in their own
 * dedicated cases below; every other test just needs *some* configured origin to get past
 * `requireWebOrigin` and reach the behavior it's actually testing. */
const WEB_ORIGIN = 'https://app.example.test'

/** A `StripeBillingClient` mock — every method a `vi.fn()`, so a test can both control what
 * Stripe "returns" and assert exactly what this hub sent it. Never a real Stripe client: per
 * the task's constraint, nothing in this file makes a real Stripe API call. */
function mockStripe(overrides: Partial<{ priceId: string }> = {}): StripeBillingClient & {
  prices: { list: ReturnType<typeof vi.fn> }
  checkout: { sessions: { create: ReturnType<typeof vi.fn> } }
  billingPortal: { sessions: { create: ReturnType<typeof vi.fn> } }
} {
  const priceId = overrides.priceId ?? 'price_resolved_123'
  return {
    prices: { list: vi.fn().mockResolvedValue({ data: [{ id: priceId }] }) },
    checkout: { sessions: { create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session_abc' }) } },
    billingPortal: { sessions: { create: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal_abc' }) } },
  }
}

describe('createCheckoutSession', () => {
  it('resolves the price by lookup key, never by a hardcoded price id', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', webOrigin: WEB_ORIGIN })

    // The Stripe call names cloud_base_monthly via `lookup_keys` — never a `price_...` id, which
    // is exactly what makes this code mode-agnostic between Stripe test and live mode.
    expect(stripe.prices.list).toHaveBeenCalledWith({ lookup_keys: ['cloud_base_monthly'], expand: ['data.product'] })
  })

  it('uses the price id Stripe resolved, as the ONLY price info in the checkout call', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe({ priceId: 'price_cloud_base_xyz' })

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', quantity: 2, webOrigin: WEB_ORIGIN })

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        line_items: [{ price: 'price_cloud_base_xyz', quantity: 2 }],
      }),
    )
  })

  it('an unknown lookup key is a validation error (400), not a 500, and never reaches Stripe', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'totally_made_up_key' }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(stripe.prices.list).not.toHaveBeenCalled()
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('an empty lookup key is also a validation error', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await expect(createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: '' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('the client cannot smuggle an amount, currency, or arbitrary price id past the lookup key', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe({ priceId: 'price_the_real_one' })

    // A caller (or a compromised/careless HTTP layer) trying to pass extra fields alongside a
    // valid lookup key — `as any` simulates a request body that was spread rather than
    // explicitly destructured.
    const smuggled = {
      orgId: 'org_a',
      lookupKey: 'cloud_base_monthly',
      webOrigin: WEB_ORIGIN,
      price: 'price_evil_free_forever',
      amount: 1,
      unit_amount: 1,
      currency: 'eur',
    } as any

    await createCheckoutSession(sql, stripe, smuggled)

    const call = stripe.checkout.sessions.create.mock.calls[0][0]
    expect(call.line_items).toEqual([{ price: 'price_the_real_one', quantity: 1 }])
    // None of the smuggled fields appear anywhere in the actual Stripe call.
    expect(JSON.stringify(call)).not.toContain('price_evil_free_forever')
    expect(JSON.stringify(call)).not.toContain('eur')
  })

  it('rejects a non-positive or non-integer quantity before calling Stripe', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', quantity: 0 }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', quantity: -3 }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', quantity: 1.5 }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(stripe.prices.list).not.toHaveBeenCalled()
  })

  it('defaults quantity to 1 when omitted', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_sso_monthly', webOrigin: WEB_ORIGIN })

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: 'price_resolved_123', quantity: 1 }] }),
    )
  })

  it('attaches the existing Stripe customer when the org has one on file', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`,
      ['org_a', 'cus_existing_123'],
    )
    const stripe = mockStripe()

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_seat_monthly', webOrigin: WEB_ORIGIN })

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_existing_123' }))
  })

  it('never sends an existing customer for an org with none on file', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_seat_monthly', webOrigin: WEB_ORIGIN })

    const call = stripe.checkout.sessions.create.mock.calls[0][0]
    expect(call.customer).toBeUndefined()
  })

  it('throws (not a ValidationError) when the catalogue is missing a price for a valid key', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()
    stripe.prices.list.mockResolvedValue({ data: [] })

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'business_seat_yearly', webOrigin: WEB_ORIGIN }),
    ).rejects.not.toBeInstanceOf(ValidationError)
  })

  it('builds success_url/cancel_url from the configured webOrigin, not a hardcoded domain', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', webOrigin: WEB_ORIGIN })

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: `${WEB_ORIGIN}/billing?checkout=success`,
        cancel_url: `${WEB_ORIGIN}/billing?checkout=cancelled`,
      }),
    )
  })

  it('refuses to create a checkout session when webOrigin is not configured, and never calls Stripe', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly' }),
    ).rejects.toThrow(/WEB_ORIGIN/)

    expect(stripe.prices.list).not.toHaveBeenCalled()
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })
})

describe('createPortalSession', () => {
  it('is a validation error when the org has no Stripe customer yet', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await expect(createPortalSession(sql, stripe, { orgId: 'org_a' })).rejects.toBeInstanceOf(ValidationError)
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })

  it('opens a portal session for the org\'s cached Stripe customer', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`,
      ['org_a', 'cus_portal_456'],
    )
    const stripe = mockStripe()

    const result = await createPortalSession(sql, stripe, { orgId: 'org_a', webOrigin: WEB_ORIGIN })

    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_portal_456' }))
    expect(result.url).toBe('https://billing.stripe.com/portal_abc')
  })

  it('builds return_url from the configured webOrigin, not a hardcoded domain', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`,
      ['org_a', 'cus_portal_origin'],
    )
    const stripe = mockStripe()

    await createPortalSession(sql, stripe, { orgId: 'org_a', webOrigin: WEB_ORIGIN })

    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ return_url: `${WEB_ORIGIN}/billing` }),
    )
  })

  it('refuses to open a portal session when webOrigin is not configured, and never calls Stripe', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`,
      ['org_a', 'cus_portal_no_origin'],
    )
    const stripe = mockStripe()

    await expect(
      createPortalSession(sql, stripe, { orgId: 'org_a' }),
    ).rejects.toThrow(/WEB_ORIGIN/)

    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })
})

/** A subscription item as `syncSubscriptionFromStripe` expects it — the full `price` object
 * with `lookup_key`, exactly how Stripe embeds it on every `SubscriptionItem` by default. */
function item(lookupKey: string, quantity: number, currentPeriodEnd = 1_800_000_000): StripeSubscriptionLike['items']['data'][number] {
  return { quantity, current_period_end: currentPeriodEnd, price: { lookup_key: lookupKey } }
}

function subscription(overrides: Partial<StripeSubscriptionLike> & { items: StripeSubscriptionLike['items'] }): StripeSubscriptionLike {
  return {
    id: 'sub_default',
    customer: 'cus_default',
    status: 'active',
    metadata: null,
    ...overrides,
  }
}

describe('syncSubscriptionFromStripe', () => {
  it('derives cached quantities from subscription ITEMS, not a single top-level quantity', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    await syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_multi', customer: 'cus_multi',
      metadata: { orgId: 'org_a' },
      items: { data: [
        item('cloud_base_monthly', 1),
        item('cloud_seat_monthly', 4),
        item('cloud_agent_pack_monthly', 2),
        item('cloud_sso_monthly', 1),
      ] },
    }))

    const row = (await sql.query(
      'SELECT seats_included, seats_purchased, agent_packs, sso_enabled, status, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE org_id = $1',
      ['org_a'],
    )).rows[0]

    expect(row).toMatchObject({
      seats_included: 3,
      seats_purchased: 4,
      agent_packs: 2,
      sso_enabled: true,
      status: 'active',
      stripe_customer_id: 'cus_multi',
      stripe_subscription_id: 'sub_multi',
    })
  })

  it('a signed checkout.session.completed-equivalent sync marks the org active', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query('UPDATE orgs SET status = $1 WHERE id = $2', ['suspended', 'org_a'])

    await syncSubscriptionFromStripe(sql, subscription({
      metadata: { orgId: 'org_a' },
      items: { data: [item('cloud_base_monthly', 1)] },
    }))

    const org = (await sql.query('SELECT status FROM orgs WHERE id = $1', ['org_a'])).rows[0]
    expect(org.status).toBe('active')
  })

  it('customer.subscription.deleted (status: canceled) suspends the org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_del', customer: 'cus_del', metadata: { orgId: 'org_a' },
      items: { data: [item('cloud_base_monthly', 1)] },
    }))
    expect((await sql.query('SELECT status FROM orgs WHERE id = $1', ['org_a'])).rows[0].status).toBe('active')

    await syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_del', customer: 'cus_del', status: 'canceled', metadata: { orgId: 'org_a' },
      items: { data: [item('cloud_base_monthly', 1)] },
    }))

    expect((await sql.query('SELECT status FROM orgs WHERE id = $1', ['org_a'])).rows[0].status).toBe('suspended')
  })

  it('replaying the same subscription state is idempotent — one row, same values', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const sub = subscription({
      id: 'sub_replay', customer: 'cus_replay', metadata: { orgId: 'org_a' },
      items: { data: [item('cloud_base_monthly', 1), item('cloud_seat_monthly', 1)] },
    })

    await syncSubscriptionFromStripe(sql, sub)
    await syncSubscriptionFromStripe(sql, sub)
    await syncSubscriptionFromStripe(sql, sub)

    const rows = (await sql.query('SELECT seats_purchased FROM subscriptions WHERE org_id = $1', ['org_a'])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].seats_purchased).toBe(1)
  })

  it('falls back to the cached stripe_customer_id when the subscription carries no metadata', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    // A prior sync (e.g. from checkout.session.completed) established the customer link.
    await syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_fallback', customer: 'cus_fallback', metadata: { orgId: 'org_a' },
      items: { data: [item('cloud_base_monthly', 1)] },
    }))

    // A later `customer.subscription.updated` whose metadata was stripped (e.g. by a dashboard
    // edit) must still resolve to org_a via the customer id already on file.
    await syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_fallback', customer: 'cus_fallback', metadata: null,
      items: { data: [item('cloud_base_monthly', 1), item('cloud_agent_pack_yearly', 3)] },
    }))

    const row = (await sql.query('SELECT agent_packs FROM subscriptions WHERE org_id = $1', ['org_a'])).rows[0]
    expect(row.agent_packs).toBe(3)
  })

  it('a subscription for no org this hub knows about is silently acknowledged, not thrown', async () => {
    const sql = await hubTestSql()

    await expect(syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_orphan', customer: 'cus_orphan', metadata: { orgId: 'org_does_not_exist' },
      items: { data: [item('cloud_base_monthly', 1)] },
    }))).resolves.toBeUndefined()

    expect((await sql.query('SELECT 1 FROM subscriptions WHERE stripe_subscription_id = $1', ['sub_orphan'])).rows).toHaveLength(0)
  })

  it('business_seat quantities fold into seats_purchased alongside cloud_seat', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    await syncSubscriptionFromStripe(sql, subscription({
      metadata: { orgId: 'org_a' },
      items: { data: [item('business_seat_monthly', 10)] },
    }))

    const row = (await sql.query('SELECT seats_included, seats_purchased FROM subscriptions WHERE org_id = $1', ['org_a'])).rows[0]
    expect(row).toMatchObject({ seats_included: 0, seats_purchased: 10 })
  })

  describe('tier', () => {
    it('a Cloud-only subscription is tier "cloud"', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_a')

      await syncSubscriptionFromStripe(sql, subscription({
        metadata: { orgId: 'org_a' },
        items: { data: [item('cloud_base_monthly', 1), item('cloud_seat_monthly', 2)] },
      }))

      const row = (await sql.query('SELECT tier FROM subscriptions WHERE org_id = $1', ['org_a'])).rows[0]
      expect(row.tier).toBe('cloud')
    })

    it('a Business-only subscription is tier "business"', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_a')

      await syncSubscriptionFromStripe(sql, subscription({
        metadata: { orgId: 'org_a' },
        items: { data: [item('business_seat_monthly', 10)] },
      }))

      const row = (await sql.query('SELECT tier FROM subscriptions WHERE org_id = $1', ['org_a'])).rows[0]
      expect(row.tier).toBe('business')
    })

    /**
     * THE test the `tier` column exists to make pass correctly. Before `tier` existed, these two
     * subscriptions were byte-identical in every cached seat column — `seats_included: 0,
     * seats_purchased: 10` both times — because a Cloud org buying only extra seats (no
     * `cloud_base` line, e.g. mid-checkout, or a `cloud_base` line that expired/was removed) and
     * a genuine Business org look the same to any seat-count-only heuristic. That ambiguity is
     * exactly the defect a prior review caught. Do NOT delete this as "redundant with the two
     * tests above" — the two tests above both happen to include (or consist entirely of) their
     * own family's line, so neither one alone exercises the specific shape that was ambiguous:
     * a seat/business line with NO corresponding base line. This test forces both cases through
     * the SAME seat quantity (10) so the only variable is which lookup-key family is present,
     * and asserts the tier values differ — if a future refactor reintroduces a
     * `seats_included === 0` (or similarly seat-count-derived) heuristic for tier, this is the
     * assertion that catches it; every other tier test in this file would still pass.
     */
    it('cloud_seat_monthly with NO cloud_base line is still tier "cloud" — and differs from a same-shaped Business subscription', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_cloud_seat_only')
      await seedOrg(sql, 'org_business_only')

      // Same seat quantity (10), same seats_included (0, since neither carries a base line),
      // same seats_purchased (10) — the ONLY difference is which lookup-key family sold the seats.
      await syncSubscriptionFromStripe(sql, subscription({
        id: 'sub_cloud_seat_only', customer: 'cus_cloud_seat_only', metadata: { orgId: 'org_cloud_seat_only' },
        items: { data: [item('cloud_seat_monthly', 10)] },
      }))
      await syncSubscriptionFromStripe(sql, subscription({
        id: 'sub_business_only', customer: 'cus_business_only', metadata: { orgId: 'org_business_only' },
        items: { data: [item('business_seat_monthly', 10)] },
      }))

      const cloudRow = (await sql.query(
        'SELECT tier, seats_included, seats_purchased FROM subscriptions WHERE org_id = $1', ['org_cloud_seat_only'],
      )).rows[0]
      const businessRow = (await sql.query(
        'SELECT tier, seats_included, seats_purchased FROM subscriptions WHERE org_id = $1', ['org_business_only'],
      )).rows[0]

      // Identical seat-column shape...
      expect(cloudRow).toMatchObject({ seats_included: 0, seats_purchased: 10 })
      expect(businessRow).toMatchObject({ seats_included: 0, seats_purchased: 10 })
      // ...but tier correctly distinguishes them anyway.
      expect(cloudRow.tier).toBe('cloud')
      expect(businessRow.tier).toBe('business')
      expect(cloudRow.tier).not.toBe(businessRow.tier)
    })

    it('a subscription mixing Cloud and Business lookup keys resolves to "cloud" deterministically and logs loudly', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_a')
      const logger: SyncLogger = { warn: vi.fn() }

      await syncSubscriptionFromStripe(sql, subscription({
        id: 'sub_mixed', metadata: { orgId: 'org_a' },
        items: { data: [item('cloud_base_monthly', 1), item('business_seat_monthly', 5)] },
      }), logger)

      const row = (await sql.query('SELECT tier FROM subscriptions WHERE org_id = $1', ['org_a'])).rows[0]
      expect(row.tier).toBe('cloud')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/both Cloud and Business/i),
        expect.objectContaining({ subscriptionId: 'sub_mixed' }),
      )
    })

    it('mixing families is deterministic regardless of item order', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_a')

      // Same mix, business line listed first this time.
      await syncSubscriptionFromStripe(sql, subscription({
        metadata: { orgId: 'org_a' },
        items: { data: [item('business_seat_monthly', 5), item('cloud_base_monthly', 1)] },
      }))

      const row = (await sql.query('SELECT tier FROM subscriptions WHERE org_id = $1', ['org_a'])).rows[0]
      expect(row.tier).toBe('cloud')
    })

    it('no recognized lookup key at all is tier "none", logs loudly, and a brand-new row gets conservative (zero) defaults', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_a')
      const logger: SyncLogger = { warn: vi.fn() }

      await syncSubscriptionFromStripe(sql, subscription({
        id: 'sub_unknown', metadata: { orgId: 'org_a' },
        items: { data: [item('some_price_not_in_our_catalogue', 1)] },
      }), logger)

      const row = (await sql.query(
        'SELECT tier, seats_included, seats_purchased, agent_packs, sso_enabled FROM subscriptions WHERE org_id = $1', ['org_a'],
      )).rows[0]
      expect(row).toMatchObject({ tier: 'none', seats_included: 0, seats_purchased: 0, agent_packs: 0, sso_enabled: false })
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/no recognized Cloud or Business lookup key/i),
        expect.objectContaining({ subscriptionId: 'sub_unknown' }),
      )
    })

    it('a resync with no recognized lookup key does NOT clobber previously cached entitlements — a data quirk never locks a paying org out', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_a')

      // A healthy prior sync established real cached entitlements.
      await syncSubscriptionFromStripe(sql, subscription({
        id: 'sub_healthy', metadata: { orgId: 'org_a' },
        items: { data: [item('cloud_base_monthly', 1), item('cloud_seat_monthly', 4), item('cloud_agent_pack_monthly', 2)] },
      }))
      const before = (await sql.query(
        'SELECT tier, seats_included, seats_purchased, agent_packs FROM subscriptions WHERE org_id = $1', ['org_a'],
      )).rows[0]
      expect(before).toMatchObject({ tier: 'cloud', seats_included: 3, seats_purchased: 4, agent_packs: 2 })

      // A later resync of the SAME subscription somehow carries no recognized lookup key (e.g.
      // a dashboard edit swapped in an ad-hoc price) — status/period still update, but the real
      // cached seat/pack numbers must survive untouched rather than being zeroed out.
      await syncSubscriptionFromStripe(sql, subscription({
        id: 'sub_healthy', status: 'active', metadata: { orgId: 'org_a' },
        items: { data: [item('some_unrelated_price', 1)] },
      }))

      const after = (await sql.query(
        'SELECT tier, seats_included, seats_purchased, agent_packs FROM subscriptions WHERE org_id = $1', ['org_a'],
      )).rows[0]
      expect(after).toMatchObject({ tier: 'none', seats_included: 3, seats_purchased: 4, agent_packs: 2 })
    })

    it('the org active/suspended mapping is unaffected by tier "none" — it still tracks subscription.status', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_a')
      await sql.query('UPDATE orgs SET status = $1 WHERE id = $2', ['suspended', 'org_a'])

      await syncSubscriptionFromStripe(sql, subscription({
        metadata: { orgId: 'org_a' }, status: 'active',
        items: { data: [item('unrecognized_price', 1)] },
      }))

      const org = (await sql.query('SELECT status FROM orgs WHERE id = $1', ['org_a'])).rows[0]
      expect(org.status).toBe('active')
    })

    it('defaults to console.warn when no logger is injected (does not throw)', async () => {
      const sql = await hubTestSql()
      await seedOrg(sql, 'org_a')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(syncSubscriptionFromStripe(sql, subscription({
        metadata: { orgId: 'org_a' },
        items: { data: [item('unrecognized_price', 1)] },
      }))).resolves.toBeUndefined()

      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })
})

/**
 * C2: the org already pays. `subscriptions.org_id` is a PRIMARY KEY, so a SECOND Stripe
 * subscription against the same customer syncs onto the SAME row and silently zeroes the
 * seats and packs the first one paid for. The server guard is the one that matters — a
 * client can always be bypassed — so these test `createCheckoutSession` directly.
 */
describe('createCheckoutSession refuses a second subscription', () => {
  async function orgWithSubscription(status: string, subscriptionId: string | null = 'sub_existing') {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, tier, seats_purchased, agent_packs)
       VALUES ($1, 'cus_existing', $2, $3, 'cloud', 4, 2)`,
      ['org_a', subscriptionId, status],
    )
    return sql
  }

  it('refuses when the org has a live subscription, names the portal, and never calls Stripe', async () => {
    const sql = await orgWithSubscription('active')
    const stripe = mockStripe()

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', webOrigin: WEB_ORIGIN }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', webOrigin: WEB_ORIGIN }),
    ).rejects.toThrow(/billing portal/)

    expect(stripe.prices.list).not.toHaveBeenCalled()
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('also refuses mid-dunning (past_due) — that subscription is still live and still billing', async () => {
    const sql = await orgWithSubscription('past_due')
    const stripe = mockStripe()

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', webOrigin: WEB_ORIGIN }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('allows checkout again once the subscription is canceled — a returning customer can re-subscribe', async () => {
    const sql = await orgWithSubscription('canceled')
    const stripe = mockStripe()

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', webOrigin: WEB_ORIGIN }),
    ).resolves.toEqual({ url: 'https://checkout.stripe.com/session_abc' })
  })

  it('allows checkout for a row that has a cached customer but never completed a subscription', async () => {
    const sql = await orgWithSubscription('inactive', null)
    const stripe = mockStripe()

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', webOrigin: WEB_ORIGIN }),
    ).resolves.toEqual({ url: 'https://checkout.stripe.com/session_abc' })
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_existing' }),
    )
  })

  /** The harm being prevented, made concrete — previously uncovered: two DIFFERENT Stripe
   * subscription ids against one org. Nothing in the sync path can keep both; the second
   * one's (base-only) quantities land on the same primary-key row and the first
   * subscription's purchased seats and packs become 0, while Stripe keeps charging for
   * both. This is why checkout refuses above rather than merely warning. */
  it('two subscription ids on one org: the second sync destroys the first subscription\'s purchased entitlements', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    await syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_first', customer: 'cus_one', metadata: { orgId: 'org_a' },
      items: { data: [item('cloud_base_monthly', 1), item('cloud_seat_monthly', 4), item('cloud_agent_pack_monthly', 2)] },
    }))
    const afterFirst = await sql.query('SELECT stripe_subscription_id, seats_purchased, agent_packs FROM subscriptions WHERE org_id = $1', ['org_a'])
    expect(afterFirst.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_first', seats_purchased: 4, agent_packs: 2 })

    await syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_second', customer: 'cus_one', metadata: { orgId: 'org_a' },
      items: { data: [item('cloud_base_monthly', 1)] },
    }))

    const rows = await sql.query('SELECT stripe_subscription_id, seats_purchased, agent_packs FROM subscriptions WHERE org_id = $1', ['org_a'])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_second', seats_purchased: 0, agent_packs: 0 })
  })
})

/**
 * I2: one declined card must not suspend a paying customer. Stripe sets `past_due` on the
 * FIRST failed charge and smart-retries for two to three weeks before giving up.
 */
describe('subscription status maps to org writability', () => {
  async function syncWithStatus(status: string) {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await syncSubscriptionFromStripe(sql, subscription({
      id: 'sub_status', customer: 'cus_status', status, metadata: { orgId: 'org_a' },
      items: { data: [item('cloud_base_monthly', 1)] },
    }))
    const org = await sql.query<{ status: string }>('SELECT status FROM orgs WHERE id = $1', ['org_a'])
    return { sql, orgStatus: org.rows[0].status }
  }

  for (const status of ['active', 'trialing', 'past_due', 'incomplete']) {
    it(`${status} keeps the org active and writable`, async () => {
      const { sql, orgStatus } = await syncWithStatus(status)
      expect(orgStatus).toBe('active')
      await expect(assertOrgWritable(sql, 'org_a')).resolves.toBeUndefined()
    })
  }

  for (const status of ['canceled', 'unpaid', 'incomplete_expired', 'paused']) {
    it(`${status} suspends the org`, async () => {
      const { sql, orgStatus } = await syncWithStatus(status)
      expect(orgStatus).toBe('suspended')
      await expect(assertOrgWritable(sql, 'org_a')).rejects.toThrow(/suspended/)
    })
  }

  it('a status this code has never seen stays writable rather than wrongly suspending a payer', async () => {
    const { orgStatus } = await syncWithStatus('some_future_stripe_status')
    expect(orgStatus).toBe('active')
  })

  it('a past_due org that later recovers to active is unaffected — it was never suspended', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const items = { data: [item('cloud_base_monthly', 1)] }
    await syncSubscriptionFromStripe(sql, subscription({ id: 'sub_dun', customer: 'cus_dun', status: 'past_due', metadata: { orgId: 'org_a' }, items }))
    await expect(assertOrgWritable(sql, 'org_a')).resolves.toBeUndefined()
    await syncSubscriptionFromStripe(sql, subscription({ id: 'sub_dun', customer: 'cus_dun', status: 'active', metadata: { orgId: 'org_a' }, items }))
    await expect(assertOrgWritable(sql, 'org_a')).resolves.toBeUndefined()
  })
})

describe('billing HTTP routes', () => {
  const servers: FastifyInstance[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
  })

  /**
   * A fully mirrored org: `clerk_user_admin` is an admin, `clerk_user_plain` a plain member.
   * Both are real `memberships` rows, because both billing routes now resolve the caller to
   * one (`requireMembership` in src/hub/server.ts) — a device token can no longer reach
   * either of them, and the portal additionally requires owner/admin.
   */
  async function billingFixture() {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    await seedUser(sql, 'user_admin', 'clerk_user_admin')
    await seedMembership(sql, 'mem_admin', 'org_a', 'user_admin', 'admin')
    await seedUser(sql, 'user_plain', 'clerk_user_plain')
    await seedMembership(sql, 'mem_plain', 'org_a', 'user_plain', 'member')
    return sql
  }

  /** `webOrigin` defaults to the test constant so every existing happy-path test gets past
   * `requireWebOrigin` without needing to know it exists — pass `null` explicitly to exercise
   * the "WEB_ORIGIN not configured" failure mode instead. `null`, not `undefined`: a JS default
   * parameter substitutes its default for an `undefined` argument regardless of whether that
   * `undefined` was explicit or just omitted, so `undefined` can't distinguish "unset on
   * purpose" from "didn't say" — `null` can. */
  async function buildServer(
    sql: Awaited<ReturnType<typeof hubTestSql>>,
    stripe: ReturnType<typeof mockStripe> | undefined,
    webOrigin: string | null = WEB_ORIGIN,
  ) {
    const server = buildHubServer(sql as any, {
      ...(stripe ? { stripeClient: stripe } : {}),
      webOrigin: webOrigin ?? undefined,
      clerkSecretKey: CLERK_SECRET,
    })
    servers.push(server)
    await server.ready()
    return server
  }

  const asAdmin = { authorization: `Bearer ${fakeClerkToken('clerk_user_admin', 'clerk_org_a')}` }
  const asMember = { authorization: `Bearer ${fakeClerkToken('clerk_user_plain', 'clerk_org_a')}` }

  it('checkout happy path returns the Stripe-provided url', async () => {
    const sql = await billingFixture()
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: asAdmin,
      payload: { lookup_key: 'cloud_base_monthly', quantity: 1 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ url: 'https://checkout.stripe.com/session_abc' })
  })

  it('portal happy path returns the Stripe-provided url when the org has a customer on file', async () => {
    const sql = await billingFixture()
    await sql.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`, ['org_a', 'cus_route_test'])
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal',
      headers: asAdmin,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ url: 'https://billing.stripe.com/portal_abc' })
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_route_test' }))
  })

  it('an unknown lookup key at the HTTP layer is a 400, not a 500', async () => {
    const sql = await billingFixture()
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: asAdmin,
      payload: { lookup_key: 'not_a_real_key' },
    })

    expect(response.statusCode).toBe(400)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  /**
   * The security fix this file previously asserted the OPPOSITE of: it used to mint a device
   * token and expect 200 from both billing routes, blessing the vulnerability.
   *
   * A device token is long-lived, never expires, and the hosting runbook has people paste it
   * by hand into a laptop config. Its holder could open the Stripe portal — cancel the plan,
   * change the payment method, read invoices carrying the billing address — because the auth
   * hook accepts device tokens on every `/api/v1/hub/` path and these routes checked only org
   * scope. Nothing a daemon does needs billing.
   */
  it('a device token — correctly scoped to this very org — cannot reach checkout or the portal', async () => {
    const sql = await billingFixture()
    await sql.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`, ['org_a', 'cus_device_denied'])
    const { token } = await mintDeviceToken(sql as any, { orgId: 'org_a', name: 'laptop' })
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)
    const asDevice = { authorization: `Bearer ${token}` }

    const checkoutResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: asDevice, payload: { lookup_key: 'cloud_base_monthly' },
    })
    const portalResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal', headers: asDevice,
    })

    expect(checkoutResponse.statusCode).toBe(403)
    expect(portalResponse.statusCode).toBe(403)
    expect(portalResponse.json().error).toMatch(/signed-in member/)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })

  it('a plain member may start checkout but may not open the portal (owner/admin only)', async () => {
    const sql = await billingFixture()
    await sql.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`, ['org_a', 'cus_role_gate'])
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const portalResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal', headers: asMember,
    })
    expect(portalResponse.statusCode).toBe(403)
    expect(portalResponse.json().error).toMatch(/owner or admin/)
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()

    const checkoutResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: asMember, payload: { lookup_key: 'cloud_base_monthly' },
    })
    expect(checkoutResponse.statusCode).toBe(200)
  })

  it('an owner may open the portal', async () => {
    const sql = await billingFixture()
    await sql.query("UPDATE memberships SET role = 'owner' WHERE id = 'mem_admin'")
    await sql.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`, ['org_a', 'cus_owner'])
    const server = await buildServer(sql, mockStripe())

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal', headers: asAdmin,
    })
    expect(response.statusCode).toBe(200)
  })

  it('a device token scoped to a different org is refused 403 before the handler runs', async () => {
    const sql = await billingFixture()
    await seedOrg(sql, 'org_b')
    // Token is scoped to org_b, but the URL asks for org_a's billing.
    const { token } = await mintDeviceToken(sql as any, { orgId: 'org_b', name: 'laptop' })
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const checkoutResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { lookup_key: 'cloud_base_monthly' },
    })
    const portalResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(checkoutResponse.statusCode).toBe(403)
    expect(portalResponse.statusCode).toBe(403)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })

  it('HTTP: an org that already has a subscription is refused checkout and told to use the portal', async () => {
    const sql = await billingFixture()
    await sql.query(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, tier)
       VALUES ($1, $2, $3, 'active', 'cloud')`,
      ['org_a', 'cus_existing', 'sub_existing'],
    )
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: asAdmin, payload: { lookup_key: 'cloud_base_monthly' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/billing portal/)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('checkout and portal both 500 with a clear body when Stripe is not configured', async () => {
    const sql = await billingFixture()
    const server = await buildServer(sql, undefined)

    const checkoutResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: asAdmin,
      payload: { lookup_key: 'cloud_base_monthly' },
    })
    const portalResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal',
      headers: asAdmin,
    })

    expect(checkoutResponse.statusCode).toBe(500)
    expect(checkoutResponse.json()).toMatchObject({ code: 'internal_error' })
    expect(portalResponse.statusCode).toBe(500)
    expect(portalResponse.json()).toMatchObject({ code: 'internal_error' })
  })

  it('checkout and portal both fail closed (500) when WEB_ORIGIN is not configured, and never reach Stripe', async () => {
    const sql = await billingFixture()
    await sql.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`, ['org_a', 'cus_no_web_origin'])
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe, null)

    const checkoutResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: asAdmin,
      payload: { lookup_key: 'cloud_base_monthly' },
    })
    const portalResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal',
      headers: asAdmin,
    })

    expect(checkoutResponse.statusCode).toBe(500)
    expect(checkoutResponse.json()).toMatchObject({ code: 'internal_error' })
    expect(portalResponse.statusCode).toBe(500)
    expect(portalResponse.json()).toMatchObject({ code: 'internal_error' })
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })
})
