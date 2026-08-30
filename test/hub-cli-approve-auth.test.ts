import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildHubServer } from '../src/hub/server.js'
import { hubTestSql, seedOrg, seedUser, seedMembership } from './support/hub-sql.js'
import { mintDeviceToken } from '../src/hub/devices.js'

// Same mock as test/hub-clerk-auth.test.ts — `@clerk/backend` is the one boundary mocked.
vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn() }))
import { verifyToken } from '@clerk/backend'
const verifyTokenMock = vi.mocked(verifyToken)

const CLERK_SECRET = 'sk_test_fixture_secret'
const clerkToken = (userId: string, orgId: string | null) => `clerk_valid.${userId}.${orgId ?? 'none'}`

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

const servers: FastifyInstance[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  verifyTokenMock.mockClear()
})

async function fixture() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a', 'clerk_org_a')
  await seedUser(sql, 'user_1', 'clerk_user_1', 'armin@example.com')
  await seedMembership(sql, 'mem_1', 'org_a', 'user_1', 'owner')
  const server = buildHubServer(sql, { clerkSecretKey: CLERK_SECRET })
  servers.push(server)
  await server.ready()
  return { sql, server }
}

async function startLogin(server: FastifyInstance) {
  const verifier = randomBytes(32).toString('base64url')
  const started = await server.inject({
    method: 'POST', url: '/api/v1/hub/cli/auth/start',
    payload: { challenge: createHash('sha256').update(verifier).digest('base64url'), label: 'mac' },
  })
  return { verifier, requestId: started.json().request_id as string }
}

/**
 * Approval is the step where a person vouches for a machine. It is deliberately the one
 * handshake route that is NOT exempt from authentication — an earlier version exempted all
 * three, which made this route unreachable and would have made every login fail.
 */
describe('POST /cli/auth/approve authentication', () => {
  it('approves for a signed-in member and completes the login', async () => {
    const hub = await fixture()
    const { verifier, requestId } = await startLogin(hub.server)

    const approved = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/approve',
      headers: { authorization: `Bearer ${clerkToken('clerk_user_1', 'clerk_org_a')}` },
      payload: { request_id: requestId },
    })

    expect(approved.statusCode).toBe(200)
    const code = approved.json().code
    expect(code).toBeTruthy()

    const exchanged = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/exchange',
      payload: { request_id: requestId, code, verifier },
    })
    expect(exchanged.statusCode).toBe(200)
    expect(exchanged.json().token).toMatch(/^orchestra_cli_v1\./)
    expect(exchanged.json().user.email).toBe('armin@example.com')
  })

  it('refuses approval with no credential at all', async () => {
    const hub = await fixture()
    const { requestId } = await startLogin(hub.server)

    const response = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/approve',
      payload: { request_id: requestId },
    })

    expect(response.statusCode).toBe(403)
    // and nothing was approved
    const rows = await hub.sql.query('SELECT approved_at FROM cli_auth_requests WHERE id = $1', [requestId])
    expect(rows.rows[0].approved_at).toBeNull()
  })

  it('refuses approval from a device token', async () => {
    const hub = await fixture()
    const { requestId } = await startLogin(hub.server)
    const { token } = await mintDeviceToken(hub.sql, { orgId: 'org_a', name: 'daemon' })

    const response = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: { request_id: requestId },
    })

    expect(response.statusCode).toBe(403)
    const rows = await hub.sql.query('SELECT approved_at FROM cli_auth_requests WHERE id = $1', [requestId])
    expect(rows.rows[0].approved_at).toBeNull()
  })

  it('refuses approval from an invalid Clerk token', async () => {
    const hub = await fixture()
    const { requestId } = await startLogin(hub.server)

    const response = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/approve',
      headers: { authorization: 'Bearer clerk_garbage' },
      payload: { request_id: requestId },
    })

    expect(response.statusCode).toBe(403)
  })

  // Starting and exchanging must stay open: the machine has no credential yet.
  it('leaves start and exchange reachable without a credential', async () => {
    const hub = await fixture()
    const started = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/start',
      payload: { challenge: 'x', label: 'mac' },
    })
    expect(started.statusCode).toBe(201)

    // reachable, and refused on its merits rather than by the auth hook
    const exchanged = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/exchange',
      payload: { request_id: started.json().request_id, code: 'nope', verifier: 'nope' },
    })
    expect(exchanged.statusCode).toBe(403)
    expect(exchanged.json().error).toMatch(/not approved/)
  })
})
