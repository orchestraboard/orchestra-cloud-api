import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildHubServer } from '../src/hub/server.js'
import { resolveOrgForClerk } from '../src/hub/clerk.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { hubTestSql, seedOrg, seedBoard, seedUser, seedMembership, seedSubscription } from './support/hub-sql.js'

// `@clerk/backend`'s `verifyToken` is the only network/crypto boundary Task 3
// crosses. Mocking it here means every test in this file runs with no network
// call and no real Clerk credentials, per the brief's "must be mockable"
// requirement — see src/hub/clerk.ts.
vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn() }))

import { verifyToken } from '@clerk/backend'
const verifyTokenMock = vi.mocked(verifyToken)

const CLERK_SECRET = 'sk_test_fixture_secret'

/**
 * A fake Clerk JWT the mock above understands: `clerk_valid.<clerkUserId>.<clerkOrgId|'none'>`.
 * Anything that doesn't match this shape (including a token that merely *looks*
 * JWT-like) is treated by the mock as a bad signature — the same as a real
 * invalid or expired token.
 */
function fakeClerkToken(clerkUserId: string, clerkOrgId: string | null): string {
  return `clerk_valid.${clerkUserId}.${clerkOrgId ?? 'none'}`
}

// The real `@clerk/backend` package-root `verifyToken` is a throwing wrapper —
// it resolves with the payload directly, or rejects, it never resolves with an
// `{ errors }` shape. The mock mirrors that so this file exercises the same
// contract src/hub/clerk.ts actually codes against.
verifyTokenMock.mockImplementation(async (token: string) => {
  const match = /^clerk_valid\.([^.]+)\.([^.]+)$/.exec(token)
  if (!match) {
    throw new Error('mock: bad signature')
  }
  const [, sub, org] = match
  return {
    __raw: token,
    iss: 'https://example.clerk.accounts.dev',
    sub,
    sid: 'sess_fixture',
    nbf: 0,
    iat: 0,
    exp: Math.floor(Date.now() / 1000) + 3600,
    org_id: org === 'none' ? undefined : org,
  }
})

const extraServers: FastifyInstance[] = []

afterEach(async () => {
  await closeHubServers()
  for (const server of extraServers.splice(0)) await server.close()
  verifyTokenMock.mockClear()
})

/**
 * A migrated database with org_a mirrored to Clerk org `clerk_org_a`, and clerk_user_1 as its
 * sole member. `secretKey: null` builds a server with Clerk auth *not* configured — distinct from
 * simply omitting the argument (a JS default parameter does not trigger on an explicit `undefined`
 * the way it might look; `null` sidesteps that ambiguity by construction).
 */
async function clerkFixture(secretKey: string | null = CLERK_SECRET) {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a', 'clerk_org_a')
  // Without a subscription this org is refused every write (`assertOrgWritable`), which
  // would make the ops assertions below fail for a reason that has nothing to do with auth.
  await seedSubscription(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  await seedUser(sql, 'user_1', 'clerk_user_1')
  await seedMembership(sql, 'mem_1', 'org_a', 'user_1')

  const server = buildHubServer(sql, { clerkSecretKey: secretKey ?? undefined })
  // Captures request.hubOrgId/hubUserId as the auth hook left them, so tests
  // can assert on the decoration directly rather than only inferring it from
  // status codes.
  const captured: Array<{ hubOrgId: string | null; hubUserId: string | null }> = []
  server.addHook('preHandler', async (request) => {
    captured.push({ hubOrgId: request.hubOrgId, hubUserId: request.hubUserId })
  })
  extraServers.push(server)
  await server.ready()

  return { sql, server, orgId: 'org_a', boardId: 'board_1', captured }
}

describe('hub server: Clerk JWT auth', () => {
  it('still authenticates a device token exactly as before (regression guard)', async () => {
    const hub = await hubFixture()
    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Still works' } },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().result.title).toBe('Still works')
    // A device-shaped token must never reach the Clerk verifier at all.
    expect(verifyTokenMock).not.toHaveBeenCalled()
  })

  it('sets hubOrgId and hubUserId for a valid Clerk JWT mapped to a mirrored membership', async () => {
    const hub = await clerkFixture()
    const token = fakeClerkToken('clerk_user_1', 'clerk_org_a')

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(hub.captured.at(-1)).toEqual({ hubOrgId: 'org_a', hubUserId: 'user_1' })
    expect(verifyTokenMock).toHaveBeenCalledWith(token, { secretKey: CLERK_SECRET })
  })

  it('accepts both a device token and a Clerk token on the same server, for the same org', async () => {
    const hub = await clerkFixture()
    const { token: deviceToken } = await mintDeviceToken(hub.sql, { orgId: 'org_a', name: 'laptop' })
    const clerkToken = fakeClerkToken('clerk_user_1', 'clerk_org_a')

    const viaDevice = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'From daemon' } },
    })
    const viaClerk = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`,
      headers: { authorization: `Bearer ${clerkToken}` },
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'From browser' } },
    })

    expect(viaDevice.statusCode).toBe(200)
    expect(viaClerk.statusCode).toBe(200)
  })

  it('refuses a valid Clerk JWT for an org the user is not a member of', async () => {
    const hub = await clerkFixture()
    await seedOrg(hub.sql, 'org_b', 'clerk_org_b')
    // clerk_user_1 has no membership row in org_b.
    const token = fakeClerkToken('clerk_user_1', 'clerk_org_b')

    const response = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/orgs/org_b/cards',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })

  it('refuses a user removed from the org even though their Clerk token has not expired', async () => {
    const hub = await clerkFixture()
    const token = fakeClerkToken('clerk_user_1', 'clerk_org_a')

    const before = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(before.statusCode).toBe(200)

    // Revoke by deleting the mirrored membership row — not by touching the token.
    await hub.sql.query('DELETE FROM memberships WHERE id = $1', ['mem_1'])

    const after = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: `Bearer ${token}` },
    })
    // Same token, same mock, same (still "unexpired") signature — only the
    // mirror-table state changed. If this passed by reading org membership
    // off the JWT instead of re-querying `memberships`, it would still be 200.
    expect(after.statusCode).toBe(403)
  })

  it('refuses a Clerk principal whose token org does not match the route :orgId', async () => {
    const hub = await clerkFixture()
    await seedOrg(hub.sql, 'org_b', 'clerk_org_b')
    await seedMembership(hub.sql, 'mem_2', 'org_b', 'user_1') // genuinely a member of org_b too
    const tokenForOrgB = fakeClerkToken('clerk_user_1', 'clerk_org_b')

    // The token resolves to org_b, but the route asks for org_a.
    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: `Bearer ${tokenForOrgB}` },
    })
    expect(response.statusCode).toBe(403)
  })

  it('gives byte-identical 403 bodies for an invalid Clerk JWT and an invalid device token', async () => {
    // Plan 1 deliberately collapsed every device-token failure to one generic
    // body so "unknown" and "revoked" can't be distinguished by an attacker.
    // A third failure mode (bad Clerk JWT) must land on that exact same body,
    // not a differently-worded one, or the oracle comes back one level up.
    const hub = await clerkFixture()

    const badClerk = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: 'Bearer not-a-real-clerk-jwt-at-all' },
    })
    const badDevice = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: 'Bearer orchestra_device_v1.totally-made-up' },
    })

    expect(badClerk.statusCode).toBe(403)
    expect(badDevice.statusCode).toBe(403)
    expect(badClerk.payload).toBe(badDevice.payload)
  })

  it('refuses a Clerk-shaped token with the generic body when clerkSecretKey is not configured, without calling verifyToken', async () => {
    const hub = await clerkFixture(null)

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`,
      headers: { authorization: 'Bearer whatever.looks.like.a.jwt' },
    })

    expect(response.statusCode).toBe(403)
    expect(verifyTokenMock).not.toHaveBeenCalled()
  })
})

describe('resolveOrgForClerk', () => {
  it('returns orgId, membershipId, and userId for a mirrored membership', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    await seedUser(sql, 'user_1', 'clerk_user_1')
    await seedMembership(sql, 'mem_1', 'org_a', 'user_1')

    const resolved = await resolveOrgForClerk(sql, { clerkUserId: 'clerk_user_1', clerkOrgId: 'clerk_org_a' })
    expect(resolved).toEqual({ orgId: 'org_a', membershipId: 'mem_1', userId: 'user_1' })
  })

  it('throws a 403 when there is no mirrored membership for that org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    await seedUser(sql, 'user_1', 'clerk_user_1')
    // No membership row.

    await expect(
      resolveOrgForClerk(sql, { clerkUserId: 'clerk_user_1', clerkOrgId: 'clerk_org_a' }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('throws a 403 when the token has no active organization', async () => {
    const sql = await hubTestSql()
    await expect(
      resolveOrgForClerk(sql, { clerkUserId: 'clerk_user_1', clerkOrgId: null }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
