import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildHubServer } from '../src/hub/server.js'
import type { StripeBillingClient } from '../src/hub/billing.js'
import type { StripeWebhookClient } from '../src/hub/webhooks/stripe.js'
import { hubTestSql, seedOrg } from './support/hub-sql.js'
import type { HubSql } from '../src/hub/sql.js'

const WEBHOOK_SECRET = 'whsec_hub_stripe_webhook_test_secret'

const servers: FastifyInstance[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

/**
 * The real `stripe` package's own `webhooks.constructEventAsync`/`generateTestHeaderStringAsync`
 * are pure HMAC — no network call, no API key validation — so using them here for BOTH signing
 * (as this file's `sign()` helper) and verifying (as the plugin's injected client) exercises
 * genuine Stripe signature verification end to end, the same way hub-clerk-webhook.test.ts uses
 * the real `standardwebhooks` library rather than a hand-rolled stand-in. The one method that
 * WOULD make a real network call, `subscriptions.retrieve`, is replaced with a `vi.fn()` below —
 * that is the "mock the Stripe SDK" boundary the task brief asks for: no real API call, ever.
 */
const realStripe = new Stripe('sk_test_not_a_real_key_00000000000000000000000000')

/** A `StripeBillingClient & StripeWebhookClient` — genuine `webhooks` from the real SDK (pure
 * crypto, network-free), `subscriptions.retrieve` mocked, and the checkout/portal methods
 * stubbed since this file never exercises those routes' happy path in depth (hub-billing.test.ts
 * already covers `createCheckoutSession`/`createPortalSession` directly). */
function buildStripeMock(): StripeBillingClient & StripeWebhookClient & { subscriptions: { retrieve: ReturnType<typeof vi.fn> } } {
  return {
    prices: { list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: {
      constructEventAsync: (payload, header, secret) => realStripe.webhooks.constructEventAsync(payload, header, secret),
    },
    subscriptions: { retrieve: vi.fn() },
  }
}

/** `secret: null` builds a server with the webhook signing secret NOT configured — distinct
 * from omitting the argument (mirrors hub-clerk-webhook.test.ts's `buildServer` convention). */
async function buildServer(
  sql: HubSql,
  stripe: ReturnType<typeof buildStripeMock>,
  secret: string | null = WEBHOOK_SECRET,
) {
  const server = buildHubServer(sql as any, { stripeWebhookSecret: secret ?? undefined, stripeClient: stripe })
  servers.push(server)
  await server.ready()
  return server
}

async function sign(body: string, secret = WEBHOOK_SECRET) {
  return realStripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret })
}

function checkoutCompletedPayload(subscriptionId: string, sessionId = `cs_${randomUUID()}`) {
  return JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, object: 'checkout.session', subscription: subscriptionId } },
  })
}

function subscriptionEventPayload(
  type: 'customer.subscription.updated' | 'customer.subscription.deleted',
  subscriptionId: string, customerId: string, status: string, orgId: string,
) {
  return JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type,
    data: {
      object: {
        id: subscriptionId,
        object: 'subscription',
        customer: customerId,
        status,
        metadata: { orgId },
        items: { data: [{ quantity: 1, current_period_end: 1_800_000_000, price: { lookup_key: 'cloud_base_monthly' } }] },
      },
    },
  })
}

function fakeSubscription(id: string, customerId: string, orgId: string) {
  return {
    id, customer: customerId, status: 'active', metadata: { orgId },
    items: { data: [
      { quantity: 1, current_period_end: 1_800_000_000, price: { lookup_key: 'cloud_base_monthly' } },
      { quantity: 2, current_period_end: 1_800_000_000, price: { lookup_key: 'cloud_seat_monthly' } },
    ] },
  }
}

describe('POST /webhooks/stripe', () => {
  it('is mounted outside /api/v1/hub/ and requires no bearer token', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = buildStripeMock()
    stripe.subscriptions.retrieve.mockResolvedValue(fakeSubscription('sub_x', 'cus_x', 'org_a'))
    const server = await buildServer(sql, stripe)

    const body = checkoutCompletedPayload('sub_x')
    const signature = await sign(body)

    // No `authorization` header — this alone would 403 if the route were reachable through the
    // bearer-token hook.
    const response = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    })
    expect(response.statusCode).toBe(200)
  })

  it('a signed checkout.session.completed fetches the subscription and marks the org active with cached quantities', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query('UPDATE orgs SET status = $1 WHERE id = $2', ['suspended', 'org_a'])
    const stripe = buildStripeMock()
    stripe.subscriptions.retrieve.mockResolvedValue(fakeSubscription('sub_checkout', 'cus_checkout', 'org_a'))
    const server = await buildServer(sql, stripe)

    const body = checkoutCompletedPayload('sub_checkout')
    const signature = await sign(body)
    const response = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    })

    expect(response.statusCode).toBe(200)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_checkout', expect.objectContaining({ expand: expect.any(Array) }))
    const org = (await sql.query('SELECT status FROM orgs WHERE id = $1', ['org_a'])).rows[0]
    expect(org.status).toBe('active')
    const row = (await sql.query('SELECT seats_included, seats_purchased FROM subscriptions WHERE org_id = $1', ['org_a'])).rows[0]
    expect(row).toMatchObject({ seats_included: 3, seats_purchased: 2 })
  })

  it('customer.subscription.deleted suspends the org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = buildStripeMock()
    stripe.subscriptions.retrieve.mockResolvedValue(fakeSubscription('sub_del', 'cus_del', 'org_a'))
    const server = await buildServer(sql, stripe)

    // Establish the org as active first, via checkout.session.completed.
    const checkoutBody = checkoutCompletedPayload('sub_del')
    await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': await sign(checkoutBody) },
      payload: checkoutBody,
    })
    expect((await sql.query('SELECT status FROM orgs WHERE id = $1', ['org_a'])).rows[0].status).toBe('active')

    const deleteBody = subscriptionEventPayload('customer.subscription.deleted', 'sub_del', 'cus_del', 'canceled', 'org_a')
    const response = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': await sign(deleteBody) },
      payload: deleteBody,
    })

    expect(response.statusCode).toBe(200)
    expect((await sql.query('SELECT status FROM orgs WHERE id = $1', ['org_a'])).rows[0].status).toBe('suspended')
  })

  it('a bad signature is rejected 400 and writes nothing', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = buildStripeMock()
    const server = await buildServer(sql, stripe)

    const body = checkoutCompletedPayload('sub_bad_sig')
    const response = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=not-the-real-signature' },
      payload: body,
    })

    expect(response.statusCode).toBe(400)
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect((await sql.query('SELECT 1 FROM subscriptions WHERE stripe_subscription_id = $1', ['sub_bad_sig'])).rows).toHaveLength(0)
  })

  it('rejects a payload signed with the wrong secret', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = buildStripeMock()
    const server = await buildServer(sql, stripe)

    const body = checkoutCompletedPayload('sub_wrong_secret')
    const wrongSignature = await sign(body, 'whsec_a_completely_different_secret')
    const response = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': wrongSignature },
      payload: body,
    })

    expect(response.statusCode).toBe(400)
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
  })

  it('replaying the same signed event is idempotent', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const stripe = buildStripeMock()
    stripe.subscriptions.retrieve.mockResolvedValue(fakeSubscription('sub_replay', 'cus_replay', 'org_a'))
    const server = await buildServer(sql, stripe)

    const body = checkoutCompletedPayload('sub_replay')
    const signature = await sign(body)

    const first = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    })
    const replay = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    })

    expect(first.statusCode).toBe(200)
    expect(replay.statusCode).toBe(200)
    const rows = (await sql.query('SELECT org_id FROM subscriptions WHERE org_id = $1', ['org_a'])).rows
    expect(rows).toHaveLength(1)
  })

  it('an unknown/unhandled event type is acknowledged 2xx rather than erroring', async () => {
    const sql = await hubTestSql()
    const stripe = buildStripeMock()
    const server = await buildServer(sql, stripe)

    const body = JSON.stringify({ id: `evt_${randomUUID()}`, object: 'event', type: 'invoice.paid', data: { object: { id: 'in_whatever' } } })
    const response = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': await sign(body) },
      payload: body,
    })

    expect(response.statusCode).toBe(200)
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
  })

  it('returns 500 and never verifies when the webhook signing secret is not configured', async () => {
    const sql = await hubTestSql()
    const stripe = buildStripeMock()
    const server = await buildServer(sql, stripe, null)

    const body = checkoutCompletedPayload('sub_noconf')
    const signature = await sign(body)
    const response = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    })

    expect(response.statusCode).toBe(500)
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
  })

  it('a missing stripe-signature header is a 400', async () => {
    const sql = await hubTestSql()
    const stripe = buildStripeMock()
    const server = await buildServer(sql, stripe)

    const body = checkoutCompletedPayload('sub_no_header')
    const response = await server.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: body,
    })

    expect(response.statusCode).toBe(400)
  })
})
