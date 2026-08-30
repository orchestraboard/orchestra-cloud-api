import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { hubFixture, closeHubServers, type HubFixture } from './support/hub-fixture.js'
import { seedUser, seedMembership } from './support/hub-sql.js'
import { approveCliAuth, startCliAuth } from '../src/hub/cli-auth.js'

afterEach(async () => { await closeHubServers() })

const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

/**
 * Logs a CLI in the way the real flow does, except for the browser's Clerk session — the
 * approval is applied directly, since the fixture has no Clerk to authenticate against.
 */
async function loginCli(hub: HubFixture, userId = 'usr_a'): Promise<string> {
  await seedUser(hub.sql, userId, `clerk_${userId}`)
  await seedMembership(hub.sql, `mem_${userId}`, hub.orgId, userId)
  const verifier = randomBytes(32).toString('base64url')
  const started = await hub.server.inject({
    method: 'POST', url: '/api/v1/hub/cli/auth/start',
    payload: { challenge: challengeFor(verifier), label: 'mac' },
  })
  expect(started.statusCode).toBe(201)
  const requestId = started.json().request_id
  const { code } = await approveCliAuth(hub.sql, { requestId, userId })
  const exchanged = await hub.server.inject({
    method: 'POST', url: '/api/v1/hub/cli/auth/exchange',
    payload: { request_id: requestId, code, verifier },
  })
  expect(exchanged.statusCode).toBe(200)
  return exchanged.json().token
}

describe('hub CLI routes', () => {
  it('completes the handshake and returns a token plus the signed-in user', async () => {
    const hub = await hubFixture()
    await seedUser(hub.sql, 'usr_a', 'clerk_usr_a', 'armin@example.com')
    await seedMembership(hub.sql, 'mem_a', hub.orgId, 'usr_a')
    const verifier = randomBytes(32).toString('base64url')
    const started = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/start',
      payload: { challenge: challengeFor(verifier), label: 'mac' },
    })
    const requestId = started.json().request_id
    const { code } = await approveCliAuth(hub.sql, { requestId, userId: 'usr_a' })

    const exchanged = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/exchange',
      payload: { request_id: requestId, code, verifier },
    })

    expect(exchanged.statusCode).toBe(200)
    expect(exchanged.json().token).toMatch(/^orchestra_cli_v1\./)
    expect(exchanged.json().user.email).toBe('armin@example.com')
  })

  it('starting a login needs no credential but grants nothing', async () => {
    const hub = await hubFixture()
    const started = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/start',
      payload: { challenge: challengeFor('v'), label: 'mac' },
    })
    expect(started.statusCode).toBe(201)
    // No token, and nothing usable came back — only an id and a deadline.
    expect(Object.keys(started.json()).sort()).toEqual(['expires_at', 'request_id'])
  })

  it('refuses approval from anything that is not a signed-in person', async () => {
    const hub = await hubFixture()
    const started = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/start',
      payload: { challenge: challengeFor('v'), label: 'mac' },
    })
    // a device token is not a human in a browser
    const response = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/auth/approve', headers: hub.auth(),
      payload: { request_id: started.json().request_id },
    })
    expect(response.statusCode).toBe(403)
  })

  it('lists the orgs the logged-in person belongs to', async () => {
    const hub = await hubFixture()
    const cliToken = await loginCli(hub)

    const response = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/cli/orgs', headers: hub.auth(cliToken),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().orgs.map((o: { org_id: string }) => o.org_id)).toEqual([hub.orgId])
  })

  it('mints a device token for an org the person belongs to', async () => {
    const hub = await hubFixture()
    const cliToken = await loginCli(hub)

    const response = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/cli/orgs/${hub.orgId}/devices`,
      headers: hub.auth(cliToken), payload: { name: 'mac' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().token).toMatch(/^orchestra_device_v1\./)
    // metered against a real membership, exactly like the browser path
    expect(response.json().device.membership_id).toBe('mem_usr_a')
  })

  it('refuses to mint for an org the person does not belong to', async () => {
    const hub = await hubFixture()
    const cliToken = await loginCli(hub)
    await hub.sql.query(`INSERT INTO orgs (id, name, slug) VALUES ('org_other','other','other')`)

    const response = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/cli/orgs/org_other/devices',
      headers: hub.auth(cliToken), payload: { name: 'mac' },
    })

    expect(response.statusCode).toBe(404)
  })

  // The scope boundary. A CLI token is for connecting a machine, never for reading or
  // writing an organization's work — and the hook leaves hubOrgId null so this holds for
  // routes that do not exist yet.
  it('is refused on every org data route', async () => {
    const hub = await hubFixture()
    const cliToken = await loginCli(hub)
    const base = `/api/v1/hub/orgs/${hub.orgId}`

    const attempts = [
      { method: 'GET' as const, url: `${base}/cards` },
      { method: 'GET' as const, url: `${base}/agents` },
      { method: 'GET' as const, url: `${base}/boards` },
      { method: 'GET' as const, url: `${base}/entitlements` },
      { method: 'GET' as const, url: `${base}/devices` },
      { method: 'GET' as const, url: `${base}/sync?catchup=1` },
      { method: 'POST' as const, url: `${base}/ops`, payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'x' } } },
      { method: 'POST' as const, url: `${base}/devices`, payload: { name: 'x' } },
    ]

    for (const attempt of attempts) {
      const response = await hub.server.inject({ ...attempt, headers: hub.auth(cliToken) })
      expect(response.statusCode, `${attempt.method} ${attempt.url} must reject a CLI token`).toBe(403)
    }
    // and nothing was written by the one that tried
    const cards = await hub.sql.query('SELECT id FROM cards WHERE org_id = $1', [hub.orgId])
    expect(cards.rows).toHaveLength(0)
  })

  it('refuses a device token on the CLI routes', async () => {
    const hub = await hubFixture()

    const orgs = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/cli/orgs', headers: hub.auth(),
    })
    const mint = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/cli/orgs/${hub.orgId}/devices`,
      headers: hub.auth(), payload: { name: 'x' },
    })

    expect(orgs.statusCode).toBe(403)
    expect(mint.statusCode).toBe(403)
  })

  it('refuses an unknown and a revoked CLI token', async () => {
    const hub = await hubFixture()
    const cliToken = await loginCli(hub)

    const unknown = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/cli/orgs', headers: hub.auth('orchestra_cli_v1.nope'),
    })
    expect(unknown.statusCode).toBe(403)

    await hub.sql.query('UPDATE cli_tokens SET revoked_at = now()')
    const revoked = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/cli/orgs', headers: hub.auth(cliToken),
    })
    expect(revoked.statusCode).toBe(403)
  })
})
