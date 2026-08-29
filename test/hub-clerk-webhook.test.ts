import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Webhook } from 'standardwebhooks'
import { buildHubServer } from '../src/hub/server.js'
import { verifyDeviceToken, mintDeviceToken } from '../src/hub/devices.js'
import { hubTestSql, seedOrg, seedUser, seedMembership } from './support/hub-sql.js'
import type { HubSql } from '../src/hub/sql.js'

// A real Svix/`standardwebhooks` secret shape (`whsec_` + base64) — same library
// `@clerk/backend`'s `verifyWebhook` uses internally, so signing with it here
// exercises genuine Svix verification, not a hand-rolled stand-in.
const WEBHOOK_SECRET = `whsec_${Buffer.from('hub-clerk-webhook-test-secret-32b').toString('base64')}`

const servers: FastifyInstance[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

/**
 * `secret: null` builds a server with the webhook signing secret NOT configured —
 * distinct from simply omitting the argument. A JS default parameter does not
 * trigger on an explicit `undefined` the way it might look, so `null` sidesteps
 * that ambiguity (same convention as `clerkFixture` in hub-clerk-auth.test.ts).
 */
async function buildServer(sql: HubSql, secret: string | null = WEBHOOK_SECRET) {
  const server = buildHubServer(sql as any, { clerkWebhookSigningSecret: secret ?? undefined })
  servers.push(server)
  await server.ready()
  return server
}

/** Signs `body` (the exact bytes to be sent) with the real Svix verifier's own signer. */
function sign(secret: string, msgId: string, timestamp: Date, body: string) {
  const wh = new Webhook(secret)
  return {
    'svix-id': msgId,
    'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'svix-signature': wh.sign(msgId, timestamp, body),
    'content-type': 'application/json',
  }
}

function userCreatedPayload(clerkUserId: string, email: string, firstName = 'Ada', lastName = 'Lovelace') {
  return JSON.stringify({
    type: 'user.created',
    object: 'event',
    data: {
      id: clerkUserId,
      email_addresses: [{ id: 'idn_1', email_address: email }],
      primary_email_address_id: 'idn_1',
      first_name: firstName,
      last_name: lastName,
    },
  })
}

function orgCreatedPayload(clerkOrgId: string, name: string, slug: string) {
  return JSON.stringify({
    type: 'organization.created',
    object: 'event',
    data: { id: clerkOrgId, name, slug },
  })
}

function membershipPayload(
  type: 'organizationMembership.created' | 'organizationMembership.updated' | 'organizationMembership.deleted',
  clerkOrgId: string, clerkUserId: string, role: 'org:admin' | 'org:member' = 'org:member',
) {
  return JSON.stringify({
    type,
    object: 'event',
    data: {
      id: `orgmem_${randomUUID()}`,
      role,
      organization: { id: clerkOrgId, name: 'whatever', slug: 'whatever' },
      public_user_data: { user_id: clerkUserId, identifier: 'whatever@example.com' },
    },
  })
}

describe('POST /webhooks/clerk', () => {
  it('is mounted outside /api/v1/hub/ and requires no bearer token', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    const body = userCreatedPayload('clerk_user_x', 'x@example.com')
    const msgId = `msg_${randomUUID()}`
    const headers = sign(WEBHOOK_SECRET, msgId, new Date(), body)

    // No `authorization` header anywhere in this file's requests — this alone
    // would 403 if the route were reachable through the bearer-token hook.
    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })
    expect(response.statusCode).toBe(200)
  })

  it('a correctly-signed user.created payload creates the mirror row', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    const body = userCreatedPayload('clerk_user_1', 'ada@example.com')
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)

    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(response.statusCode).toBe(200)
    const rows = (await sql.query('SELECT clerk_user_id, email, display_name FROM users WHERE clerk_user_id = $1', ['clerk_user_1'])).rows
    expect(rows).toEqual([{ clerk_user_id: 'clerk_user_1', email: 'ada@example.com', display_name: 'Ada Lovelace' }])
  })

  it('a payload with a bad signature is rejected 400 and writes nothing', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    const body = userCreatedPayload('clerk_user_bad', 'bad@example.com')
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)
    // Corrupt the signature only — same body, same id, same timestamp.
    headers['svix-signature'] = 'v1,not-the-real-signature-at-all=='

    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(response.statusCode).toBe(400)
    const rows = (await sql.query('SELECT 1 FROM users WHERE clerk_user_id = $1', ['clerk_user_bad'])).rows
    expect(rows).toHaveLength(0)
  })

  it('rejects a payload signed with the wrong secret', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    const body = userCreatedPayload('clerk_user_wrong_secret', 'wrong@example.com')
    const wrongSecret = `whsec_${Buffer.from('a-completely-different-secret-32').toString('base64')}`
    const headers = sign(wrongSecret, `msg_${randomUUID()}`, new Date(), body)

    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(response.statusCode).toBe(400)
    const rows = (await sql.query('SELECT 1 FROM users WHERE clerk_user_id = $1', ['clerk_user_wrong_secret'])).rows
    expect(rows).toHaveLength(0)
  })

  it('verifies against the exact received bytes, not a re-serialized body (pretty-printed + unicode payload)', async () => {
    // A hand-rolled verifier that re-serializes `JSON.parse(body)` before checking
    // the signature would pass every other test in this file (they all sign a
    // minified, canonical JSON.stringify output) while failing here, because this
    // body is intentionally NOT the canonical minified form: real Clerk traffic is
    // pretty-printed with entirely different whitespace and key ordering than
    // `JSON.stringify` produces. If the raw buffer isn't what actually gets
    // verified, this request's signature won't match the reconstructed body and
    // this test fails with a 400.
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    const body = JSON.stringify(
      {
        object: 'event',
        type: 'user.created',
        data: {
          last_name: 'Café',
          first_name: 'Résumé Öwner',
          primary_email_address_id: 'idn_1',
          email_addresses: [{ id: 'idn_1', email_address: 'unicode@example.com' }],
          id: 'clerk_user_unicode',
        },
      },
      null,
      2,
    )
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)

    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(response.statusCode).toBe(200)
    const rows = (await sql.query('SELECT display_name FROM users WHERE clerk_user_id = $1', ['clerk_user_unicode'])).rows
    expect(rows).toEqual([{ display_name: 'Résumé Öwner Café' }])
  })

  it('replaying the same event (same Svix message id, same body) is a no-op, not a duplicate', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    await seedUser(sql, 'user_1', 'clerk_user_1')

    const body = membershipPayload('organizationMembership.created', 'clerk_org_a', 'clerk_user_1')
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)

    const first = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })
    const replay = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(first.statusCode).toBe(200)
    expect(replay.statusCode).toBe(200)
    const rows = (await sql.query('SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2', ['org_a', 'user_1'])).rows
    expect(rows).toHaveLength(1)
  })

  it('organizationMembership.deleted removes the membership and revokes that member device token', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    await seedUser(sql, 'user_1', 'clerk_user_1')
    await seedMembership(sql, 'mem_1', 'org_a', 'user_1')
    const { token } = await mintDeviceToken(sql, { orgId: 'org_a', membershipId: 'mem_1', name: 'laptop' })

    // Sanity check: the token genuinely works before removal.
    await expect(verifyDeviceToken(sql, token)).resolves.toMatchObject({ id: expect.any(String) })

    const body = membershipPayload('organizationMembership.deleted', 'clerk_org_a', 'clerk_user_1')
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)
    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })
    expect(response.statusCode).toBe(200)

    const membershipRows = (await sql.query('SELECT 1 FROM memberships WHERE id = $1', ['mem_1'])).rows
    expect(membershipRows).toHaveLength(0)

    // The security-critical assertion: not merely that the membership row is
    // gone, but that the device token functionally no longer authenticates.
    await expect(verifyDeviceToken(sql, token)).rejects.toThrow()
  })

  it('replaying organizationMembership.deleted after the membership is already gone is a no-op, not an error', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    await seedUser(sql, 'user_1', 'clerk_user_1')
    await seedMembership(sql, 'mem_1', 'org_a', 'user_1')

    const body = membershipPayload('organizationMembership.deleted', 'clerk_org_a', 'clerk_user_1')
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)

    const first = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })
    const replay = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(first.statusCode).toBe(200)
    expect(replay.statusCode).toBe(200)
  })

  it('an unknown/unhandled event type is acknowledged 2xx rather than erroring', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    const body = JSON.stringify({ type: 'session.created', object: 'event', data: { id: 'sess_whatever' } })
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)

    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })
    expect(response.statusCode).toBe(200)
  })

  it('accepts a membership created over the org seat cap rather than rejecting the webhook', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    await sql.query('UPDATE orgs SET seat_cap = 1 WHERE id = $1', ['org_a'])
    await seedUser(sql, 'user_1', 'clerk_user_1')
    await seedUser(sql, 'user_2', 'clerk_user_2')
    await seedMembership(sql, 'mem_1', 'org_a', 'user_1')

    // user_2 joining would put org_a at 2 members against a seat_cap of 1.
    const body = membershipPayload('organizationMembership.created', 'clerk_org_a', 'clerk_user_2')
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)
    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(response.statusCode).toBe(200)
    const rows = (await sql.query('SELECT user_id FROM memberships WHERE org_id = $1 ORDER BY user_id', ['org_a'])).rows
    expect(rows).toEqual([{ user_id: 'user_1' }, { user_id: 'user_2' }])
  })

  it('user.deleted cascades to memberships and devices, revoking every device across every org', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    await seedUser(sql, 'user_1', 'clerk_user_1')
    await seedMembership(sql, 'mem_1', 'org_a', 'user_1')
    const { token } = await mintDeviceToken(sql, { orgId: 'org_a', membershipId: 'mem_1', name: 'laptop' })
    await expect(verifyDeviceToken(sql, token)).resolves.toBeTruthy()

    const body = JSON.stringify({
      type: 'user.deleted',
      object: 'event',
      data: { object: 'user', id: 'clerk_user_1', deleted: true },
    })
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)
    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(response.statusCode).toBe(200)
    expect((await sql.query('SELECT 1 FROM users WHERE clerk_user_id = $1', ['clerk_user_1'])).rows).toHaveLength(0)
    expect((await sql.query('SELECT 1 FROM memberships WHERE id = $1', ['mem_1'])).rows).toHaveLength(0)
    await expect(verifyDeviceToken(sql, token)).rejects.toThrow()
  })

  it('organization.created and organizationMembership.created upsert through Clerk-assigned ids, end to end', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql)

    const orgBody = orgCreatedPayload('clerk_org_e2e', 'Acme', 'acme')
    const orgHeaders = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), orgBody)
    const orgResponse = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers: orgHeaders, payload: orgBody })
    expect(orgResponse.statusCode).toBe(200)

    const userBody = userCreatedPayload('clerk_user_e2e', 'e2e@example.com')
    const userHeaders = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), userBody)
    const userResponse = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers: userHeaders, payload: userBody })
    expect(userResponse.statusCode).toBe(200)

    const membershipBody = membershipPayload('organizationMembership.created', 'clerk_org_e2e', 'clerk_user_e2e', 'org:admin')
    const membershipHeaders = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), membershipBody)
    const membershipResponse = await server.inject({
      method: 'POST', url: '/webhooks/clerk', headers: membershipHeaders, payload: membershipBody,
    })
    expect(membershipResponse.statusCode).toBe(200)

    const rows = (await sql.query(
      `SELECT m.role FROM memberships m
       JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
       WHERE o.clerk_org_id = $1 AND u.clerk_user_id = $2`,
      ['clerk_org_e2e', 'clerk_user_e2e'],
    )).rows
    expect(rows).toEqual([{ role: 'admin' }])
  })

  it('returns 500 and never verifies when the webhook signing secret is not configured', async () => {
    const sql = await hubTestSql()
    const server = await buildServer(sql, null)
    const body = userCreatedPayload('clerk_user_noconf', 'noconf@example.com')
    const headers = sign(WEBHOOK_SECRET, `msg_${randomUUID()}`, new Date(), body)

    const response = await server.inject({ method: 'POST', url: '/webhooks/clerk', headers, payload: body })

    expect(response.statusCode).toBe(500)
    const rows = (await sql.query('SELECT 1 FROM users WHERE clerk_user_id = $1', ['clerk_user_noconf'])).rows
    expect(rows).toHaveLength(0)
  })
})
