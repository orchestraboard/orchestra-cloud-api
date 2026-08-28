import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createCheckoutSession, createPortalSession, syncSubscriptionFromStripe, type StripeBillingClient, type StripeSubscriptionLike, type SyncLogger } from '../src/hub/billing.js'
import { ValidationError } from '../src/hub/errors.js'
import { buildHubServer } from '../src/hub/server.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import { hubTestSql, seedOrg } from './support/hub-sql.js'

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

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly' })

    // The Stripe call names cloud_base_monthly via `lookup_keys` — never a `price_...` id, which
    // is exactly what makes this code mode-agnostic between Stripe test and live mode.
    expect(stripe.prices.list).toHaveBeenCalledWith({ lookup_keys: ['cloud_base_monthly'], expand: ['data.product'] })
  })

  it('uses the price id Stripe resolved, as the ONLY price info in the checkout call', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe({ priceId: 'price_cloud_base_xyz' })

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_base_monthly', quantity: 2 })

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

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_sso_monthly' })

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

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_seat_monthly' })

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_existing_123' }))
  })

  it('never sends an existing customer for an org with none on file', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()

    await createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'cloud_seat_monthly' })

    const call = stripe.checkout.sessions.create.mock.calls[0][0]
    expect(call.customer).toBeUndefined()
  })

  it('throws (not a ValidationError) when the catalogue is missing a price for a valid key', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = mockStripe()
    stripe.prices.list.mockResolvedValue({ data: [] })

    await expect(
      createCheckoutSession(sql, stripe, { orgId: 'org_a', lookupKey: 'business_seat_yearly' }),
    ).rejects.not.toBeInstanceOf(ValidationError)
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

    const result = await createPortalSession(sql, stripe, { orgId: 'org_a' })

    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_portal_456' }))
    expect(result.url).toBe('https://billing.stripe.com/portal_abc')
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

describe('billing HTTP routes', () => {
  const servers: FastifyInstance[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
  })

  async function buildServer(sql: Awaited<ReturnType<typeof hubTestSql>>, stripe: ReturnType<typeof mockStripe> | undefined) {
    const server = buildHubServer(sql as any, stripe ? { stripeClient: stripe } : {})
    servers.push(server)
    await server.ready()
    return server
  }

  it('checkout happy path returns the Stripe-provided url', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const { token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { lookup_key: 'cloud_base_monthly', quantity: 1 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ url: 'https://checkout.stripe.com/session_abc' })
  })

  it('portal happy path returns the Stripe-provided url when the org has a customer on file', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1, $2, 'active')`, ['org_a', 'cus_route_test'])
    const { token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ url: 'https://billing.stripe.com/portal_abc' })
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_route_test' }))
  })

  it('an unknown lookup key at the HTTP layer is a 400, not a 500', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const { token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })
    const stripe = mockStripe()
    const server = await buildServer(sql, stripe)

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { lookup_key: 'not_a_real_key' },
    })

    expect(response.statusCode).toBe(400)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a device token scoped to a different org is refused 403 before the handler runs', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')
    // Token is scoped to org_b, but the URL asks for org_a's billing.
    const { token } = await mintDeviceToken(sql, { orgId: 'org_b', name: 'laptop' })
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

  it('checkout and portal both 500 with a clear body when Stripe is not configured', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const { token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })
    const server = await buildServer(sql, undefined)

    const checkoutResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { lookup_key: 'cloud_base_monthly' },
    })
    const portalResponse = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/billing/portal',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(checkoutResponse.statusCode).toBe(500)
    expect(checkoutResponse.json()).toMatchObject({ code: 'internal_error' })
    expect(portalResponse.statusCode).toBe(500)
    expect(portalResponse.json()).toMatchObject({ code: 'internal_error' })
  })
})
