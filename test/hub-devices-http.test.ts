import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildHubServer } from '../src/hub/server.js'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { hubTestSql, seedOrg, seedUser, seedMembership } from './support/hub-sql.js'

// Same mock as test/hub-clerk-auth.test.ts — see that file's comment for why
// `@clerk/backend` is the one boundary this suite mocks.
vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn() }))

import { verifyToken } from '@clerk/backend'
const verifyTokenMock = vi.mocked(verifyToken)

const CLERK_SECRET = 'sk_test_fixture_secret'

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

afterEach(async () => {
  await closeHubServers()
  verifyTokenMock.mockClear()
})

async function clerkMemberFixture() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a', 'clerk_org_a')
  await seedUser(sql, 'user_1', 'clerk_user_1')
  await seedMembership(sql, 'mem_1', 'org_a', 'user_1')
  const server = buildHubServer(sql, { clerkSecretKey: CLERK_SECRET })
  await server.ready()
  return { sql, server, orgId: 'org_a' }
}

describe('POST /orgs/:orgId/devices', () => {
  it('mints a device token for a signed-in member and returns the plaintext once', async () => {
    const hub = await clerkMemberFixture()
    const token = fakeClerkToken('clerk_user_1', 'clerk_org_a')

    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/devices`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'my-laptop' },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.token).toMatch(/^orchestra_device_v1\./)
    expect(body.device.name).toBe('my-laptop')
    expect(body.device.org_id).toBe('org_a')
    expect(body.device).not.toHaveProperty('token_hash')

    await hub.server.close()
  })

  it('refuses a device token trying to mint another device token (no membership behind it)', async () => {
    const hub = await hubFixture()

    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/devices`,
      headers: hub.auth(),
      payload: { name: 'second-device' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatch(/signed-in member/)
  })

  it('surfaces the over-cap seat refusal message rather than a generic error', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a', 'clerk_org_a')
    // seat_cap defaults to 5 when there is no subscriptions row — seed 5
    // members ahead of the test's own member, in join order, so it ranks #6
    // (over cap) rather than #1.
    for (let i = 1; i <= 5; i++) {
      await seedUser(sql, `user_${i}`, `clerk_user_${i}`)
      await seedMembership(sql, `mem_${i}`, 'org_a', `user_${i}`)
    }
    await seedUser(sql, 'user_6', 'clerk_user_6')
    await seedMembership(sql, 'mem_6', 'org_a', 'user_6')
    const server = buildHubServer(sql, { clerkSecretKey: CLERK_SECRET })
    await server.ready()
    const token = fakeClerkToken('clerk_user_6', 'clerk_org_a')

    const response = await server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/devices',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'over-cap-laptop' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatch(/seat cap reached/)

    await server.close()
  })
})
