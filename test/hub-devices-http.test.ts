import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildHubServer } from '../src/hub/server.js'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { mintDeviceToken, verifyDeviceToken } from '../src/hub/devices.js'
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
  for (const server of extraServers.splice(0)) await server.close()
  verifyTokenMock.mockClear()
})

const extraServers: FastifyInstance[] = []

async function clerkMemberFixture(role: 'owner' | 'admin' | 'member' = 'member') {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a', 'clerk_org_a')
  await seedUser(sql, 'user_1', 'clerk_user_1')
  await seedMembership(sql, 'mem_1', 'org_a', 'user_1', role)
  const server = buildHubServer(sql, { clerkSecretKey: CLERK_SECRET })
  extraServers.push(server)
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

/**
 * C3: `revokeDevice` (src/hub/devices.ts) shipped in Task 2 with no caller outside its own
 * tests, so a leaked device token — which never expires — could not be revoked through the
 * product at all. The only remedies were removing the member from Clerk (which cascades away
 * ALL their devices) or a manual UPDATE against the database.
 */
describe('device listing and revocation', () => {
  it('lists the org\'s devices without ever exposing a token hash', async () => {
    const hub = await clerkMemberFixture()
    const clerk = { authorization: `Bearer ${fakeClerkToken('clerk_user_1', 'clerk_org_a')}` }
    await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/devices', headers: clerk, payload: { name: 'laptop' },
    })

    const response = await hub.server.inject({ method: 'GET', url: '/api/v1/hub/orgs/org_a/devices', headers: clerk })

    expect(response.statusCode).toBe(200)
    const [device] = response.json().devices
    expect(device).toMatchObject({ org_id: 'org_a', name: 'laptop', revoked_at: null })
    expect(device).not.toHaveProperty('token_hash')
    expect(JSON.stringify(response.json())).not.toContain('token_hash')
  })

  it('revoking a device makes its token stop working on the very next request', async () => {
    const hub = await clerkMemberFixture()
    const clerk = { authorization: `Bearer ${fakeClerkToken('clerk_user_1', 'clerk_org_a')}` }
    const minted = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/devices', headers: clerk, payload: { name: 'leaked-laptop' },
    })
    const { device, token } = minted.json()

    const before = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/orgs/org_a/cards', headers: { authorization: `Bearer ${token}` },
    })
    expect(before.statusCode).toBe(200)

    const revoked = await hub.server.inject({
      method: 'DELETE', url: `/api/v1/hub/orgs/org_a/devices/${device.id}`, headers: clerk,
    })
    expect(revoked.statusCode).toBe(204)

    const after = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/orgs/org_a/cards', headers: { authorization: `Bearer ${token}` },
    })
    expect(after.statusCode).toBe(403)
    await expect(verifyDeviceToken(hub.sql, token)).rejects.toThrow(/revoked/)
  })

  it('a device token cannot revoke devices — only a signed-in member can', async () => {
    const hub = await clerkMemberFixture()
    const { device, token } = await mintDeviceToken(hub.sql as any, { orgId: 'org_a', membershipId: 'mem_1', name: 'laptop' })

    const response = await hub.server.inject({
      method: 'DELETE', url: `/api/v1/hub/orgs/org_a/devices/${device.id}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(403)
    await expect(verifyDeviceToken(hub.sql, token)).resolves.toMatchObject({ id: device.id })
  })

  it('a plain member may revoke their own device but not another member\'s', async () => {
    const hub = await clerkMemberFixture('member')
    await seedUser(hub.sql, 'user_2', 'clerk_user_2')
    await seedMembership(hub.sql, 'mem_2', 'org_a', 'user_2', 'member')
    const mine = await mintDeviceToken(hub.sql as any, { orgId: 'org_a', membershipId: 'mem_1', name: 'mine' })
    const theirs = await mintDeviceToken(hub.sql as any, { orgId: 'org_a', membershipId: 'mem_2', name: 'theirs' })
    const clerk = { authorization: `Bearer ${fakeClerkToken('clerk_user_1', 'clerk_org_a')}` }

    const own = await hub.server.inject({
      method: 'DELETE', url: `/api/v1/hub/orgs/org_a/devices/${mine.device.id}`, headers: clerk,
    })
    const other = await hub.server.inject({
      method: 'DELETE', url: `/api/v1/hub/orgs/org_a/devices/${theirs.device.id}`, headers: clerk,
    })

    expect(own.statusCode).toBe(204)
    expect(other.statusCode).toBe(404)
    await expect(verifyDeviceToken(hub.sql, theirs.token)).resolves.toMatchObject({ id: theirs.device.id })
  })

  it('an admin may revoke any device in the org', async () => {
    const hub = await clerkMemberFixture('admin')
    await seedUser(hub.sql, 'user_2', 'clerk_user_2')
    await seedMembership(hub.sql, 'mem_2', 'org_a', 'user_2', 'member')
    const theirs = await mintDeviceToken(hub.sql as any, { orgId: 'org_a', membershipId: 'mem_2', name: 'theirs' })

    const response = await hub.server.inject({
      method: 'DELETE', url: `/api/v1/hub/orgs/org_a/devices/${theirs.device.id}`,
      headers: { authorization: `Bearer ${fakeClerkToken('clerk_user_1', 'clerk_org_a')}` },
    })

    expect(response.statusCode).toBe(204)
    await expect(verifyDeviceToken(hub.sql, theirs.token)).rejects.toThrow(/revoked/)
  })

  it('a device id from another org is a 404, never an existence oracle', async () => {
    const hub = await clerkMemberFixture('admin')
    await seedOrg(hub.sql, 'org_b')
    const foreign = await mintDeviceToken(hub.sql as any, { orgId: 'org_b', name: 'foreign' })
    const clerk = { authorization: `Bearer ${fakeClerkToken('clerk_user_1', 'clerk_org_a')}` }

    const real = await hub.server.inject({
      method: 'DELETE', url: `/api/v1/hub/orgs/org_a/devices/${foreign.device.id}`, headers: clerk,
    })
    const imaginary = await hub.server.inject({
      method: 'DELETE', url: '/api/v1/hub/orgs/org_a/devices/dev_does_not_exist', headers: clerk,
    })

    expect(real.statusCode).toBe(404)
    expect(imaginary.statusCode).toBe(404)
    expect(real.json()).toEqual(imaginary.json())
    await expect(verifyDeviceToken(hub.sql, foreign.token)).resolves.toMatchObject({ org_id: 'org_b' })
  })
})
