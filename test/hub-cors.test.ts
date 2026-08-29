import { describe, it, expect, afterEach } from 'vitest'
import { buildHubServer } from '../src/hub/server.js'
import { hubTestSql } from './support/hub-sql.js'
import type { FastifyInstance } from 'fastify'

const ALLOWED_ORIGIN = 'https://app.example.com'
const OTHER_ORIGIN = 'https://evil.example.com'

const servers: FastifyInstance[] = []

async function serverWithOrigin(webOrigin: string | undefined): Promise<FastifyInstance> {
  const sql = await hubTestSql()
  const server = buildHubServer(sql as any, { webOrigin })
  servers.push(server)
  await server.ready()
  return server
}

const preflight = (server: FastifyInstance, origin: string) => server.inject({
  method: 'OPTIONS',
  url: '/api/v1/hub/orgs/org_a/cards',
  headers: { origin, 'access-control-request-method': 'GET' },
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

describe('hub CORS', () => {
  it('echoes the configured origin on a preflight from that origin, with credentials allowed', async () => {
    const server = await serverWithOrigin(ALLOWED_ORIGIN)
    const response = await preflight(server, ALLOWED_ORIGIN)

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
  })

  it('sets Vary: Origin, since the allowed-origin response differs per request origin', async () => {
    const server = await serverWithOrigin(ALLOWED_ORIGIN)
    const response = await preflight(server, ALLOWED_ORIGIN)

    // A shared cache (CDN, corporate proxy) that ignored Vary could otherwise
    // serve one origin's cached CORS response to a different origin.
    const vary = response.headers.vary
    expect(vary).toBeDefined()
    expect(String(vary).toLowerCase().split(',').map((s) => s.trim())).toContain('origin')
  })

  it('gives a preflight from a different origin no allow-origin header at all, and never "*"', async () => {
    const server = await serverWithOrigin(ALLOWED_ORIGIN)
    const response = await preflight(server, OTHER_ORIGIN)

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-origin']).not.toBe('*')
  })

  it('never widens to "*" even for the configured origin', async () => {
    const server = await serverWithOrigin(ALLOWED_ORIGIN)
    const response = await preflight(server, ALLOWED_ORIGIN)

    expect(response.headers['access-control-allow-origin']).not.toBe('*')
  })

  it('registers no CORS at all when webOrigin is unset (local development)', async () => {
    const server = await serverWithOrigin(undefined)
    const response = await preflight(server, ALLOWED_ORIGIN)

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.headers.vary).toBeUndefined()
  })

  it('adds no CORS headers to a disallowed-origin preflight even on an unrelated origin string', async () => {
    // Guards against a substring/prefix bug in the origin comparison
    // (e.g. `https://app.example.com` matching `https://app.example.com.evil.tld`).
    const server = await serverWithOrigin(ALLOWED_ORIGIN)
    const response = await preflight(server, `${ALLOWED_ORIGIN}.evil.tld`)

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
