import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  startCliAuth,
  approveCliAuth,
  exchangeCliAuth,
  verifyCliToken,
  listUserOrgs,
  requireCliMembership,
  CLI_TOKEN_PREFIX,
} from '../src/hub/cli-auth.js'
import { hubTestSql, seedOrg, seedUser, seedMembership } from './support/hub-sql.js'
import type { HubSql } from '../src/hub/sql.js'

const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

async function seedPerson(sql: HubSql, { orgId = 'org_a', userId = 'usr_a' } = {}) {
  await seedOrg(sql, orgId)
  await seedUser(sql, userId, `clerk_${userId}`)
  await seedMembership(sql, `mem_${userId}_${orgId}`, orgId, userId)
  return { orgId, userId }
}

/** The full browser handoff, as the CLI drives it. */
async function login(sql: HubSql, userId: string) {
  const verifier = randomBytes(32).toString('base64url')
  const request = await startCliAuth(sql, { challenge: challengeFor(verifier), label: 'mac' })
  const { code } = await approveCliAuth(sql, { requestId: request.id, userId })
  return { verifier, request, code }
}

describe('hub CLI auth', () => {
  it('issues a CLI token for an approved request and never stores it in plaintext', async () => {
    const sql = await hubTestSql()
    const { userId } = await seedPerson(sql)
    const { verifier, request, code } = await login(sql, userId)

    const issued = await exchangeCliAuth(sql, { requestId: request.id, code, verifier })

    expect(issued.token.startsWith(CLI_TOKEN_PREFIX)).toBe(true)
    expect(issued.userId).toBe(userId)
    const stored = await sql.query<{ token_hash: string }>('SELECT token_hash FROM cli_tokens')
    expect(stored.rows[0].token_hash).not.toContain(issued.token)
    expect(await verifyCliToken(sql, issued.token)).toMatchObject({ userId })
  })

  it('refuses a replayed code', async () => {
    const sql = await hubTestSql()
    const { userId } = await seedPerson(sql)
    const { verifier, request, code } = await login(sql, userId)

    await exchangeCliAuth(sql, { requestId: request.id, code, verifier })
    await expect(exchangeCliAuth(sql, { requestId: request.id, code, verifier }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  // The whole point of PKCE here: a code lifted from the redirect URL is not enough.
  it('refuses the right code with the wrong verifier', async () => {
    const sql = await hubTestSql()
    const { userId } = await seedPerson(sql)
    const { request, code } = await login(sql, userId)

    await expect(exchangeCliAuth(sql, {
      requestId: request.id, code, verifier: randomBytes(32).toString('base64url'),
    })).rejects.toMatchObject({ statusCode: 403 })
    expect((await sql.query('SELECT id FROM cli_tokens')).rows).toHaveLength(0)
  })

  it('refuses the right verifier with the wrong code', async () => {
    const sql = await hubTestSql()
    const { userId } = await seedPerson(sql)
    const { verifier, request } = await login(sql, userId)

    await expect(exchangeCliAuth(sql, {
      requestId: request.id, code: randomBytes(32).toString('base64url'), verifier,
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses an exchange before anyone approved', async () => {
    const sql = await hubTestSql()
    await seedPerson(sql)
    const verifier = randomBytes(32).toString('base64url')
    const request = await startCliAuth(sql, { challenge: challengeFor(verifier), label: 'mac' })

    await expect(exchangeCliAuth(sql, {
      requestId: request.id, code: randomBytes(32).toString('base64url'), verifier,
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses a second approval of the same request', async () => {
    const sql = await hubTestSql()
    const { userId } = await seedPerson(sql)
    const verifier = randomBytes(32).toString('base64url')
    const request = await startCliAuth(sql, { challenge: challengeFor(verifier), label: 'mac' })

    await approveCliAuth(sql, { requestId: request.id, userId })
    await expect(approveCliAuth(sql, { requestId: request.id, userId }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses an expired request', async () => {
    const sql = await hubTestSql()
    const { userId } = await seedPerson(sql)
    const { verifier, request, code } = await login(sql, userId)
    await sql.query(`UPDATE cli_auth_requests SET expires_at = now() - make_interval(secs => 1)`)

    await expect(exchangeCliAuth(sql, { requestId: request.id, code, verifier }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses an unknown and a revoked token', async () => {
    const sql = await hubTestSql()
    const { userId } = await seedPerson(sql)
    const { verifier, request, code } = await login(sql, userId)
    const issued = await exchangeCliAuth(sql, { requestId: request.id, code, verifier })

    await expect(verifyCliToken(sql, `${CLI_TOKEN_PREFIX}nonsense`)).rejects.toMatchObject({ statusCode: 403 })
    await sql.query('UPDATE cli_tokens SET revoked_at = now()')
    await expect(verifyCliToken(sql, issued.token)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('lists every org the person belongs to, and refuses one they do not', async () => {
    const sql = await hubTestSql()
    const { userId } = await seedPerson(sql, { orgId: 'org_a' })
    await seedOrg(sql, 'org_b')
    await seedMembership(sql, 'mem_b', 'org_b', userId, 'owner')
    await seedOrg(sql, 'org_other')

    const orgs = await listUserOrgs(sql, userId)
    expect(orgs.map((o) => o.org_id).sort()).toEqual(['org_a', 'org_b'])

    expect(await requireCliMembership(sql, userId, 'org_a')).toMatchObject({ membershipId: `mem_${userId}_org_a` })
    await expect(requireCliMembership(sql, userId, 'org_other')).rejects.toMatchObject({ statusCode: 404 })
  })
})
