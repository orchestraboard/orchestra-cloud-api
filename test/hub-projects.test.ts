import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Webhook } from 'standardwebhooks'
import { buildHubServer } from '../src/hub/server.js'
import { createProject, ensureDefaultProject, listBoards, DEFAULT_PROJECT_NAME } from '../src/hub/projects.js'
import { ConflictError, ValidationError } from '../src/hub/errors.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import {
  hubTestSql, seedOrg, seedUser, seedMembership, seedSubscription,
} from './support/hub-sql.js'
import type { HubSqlPool } from '../src/hub/sql.js'

/**
 * C1: before this, nothing under src/hub/ ever inserted into `projects` or `boards`, while
 * every write op requires a `board_id` that already exists. A customer could pay, sign in,
 * and have nothing to point a daemon at — invisible to every scoped review because the test
 * suite seeds boards with raw SQL (test/support/hub-sql.ts).
 */

vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn() }))
import { verifyToken } from '@clerk/backend'
const verifyTokenMock = vi.mocked(verifyToken)

const CLERK_SECRET = 'sk_test_projects_secret'
const WEBHOOK_SECRET = `whsec_${Buffer.from('hub-projects-webhook-secret-32by').toString('base64')}`

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

const servers: FastifyInstance[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  verifyTokenMock.mockClear()
})

/** A mirrored org with one member and an active subscription — project creation is a write,
 * so an org with no subscription is refused it (see `assertOrgWritable`). */
async function projectFixture(options: { subscribed?: boolean } = {}) {
  const sql = (await hubTestSql()) as HubSqlPool
  await seedOrg(sql, 'org_a', 'clerk_org_a')
  if (options.subscribed !== false) await seedSubscription(sql, 'org_a')
  await seedUser(sql, 'user_1', 'clerk_user_1')
  await seedMembership(sql, 'mem_1', 'org_a', 'user_1')

  const server = buildHubServer(sql, { clerkSecretKey: CLERK_SECRET, clerkWebhookSigningSecret: WEBHOOK_SECRET })
  servers.push(server)
  await server.ready()
  return { sql, server, auth: { authorization: `Bearer ${fakeClerkToken('clerk_user_1', 'clerk_org_a')}` } }
}

describe('createProject', () => {
  it('creates a project and its first board together', async () => {
    const sql = (await hubTestSql()) as HubSqlPool
    await seedOrg(sql, 'org_a')

    const { project, board } = await createProject(sql, { orgId: 'org_a', name: 'orchestra' })

    expect(project).toMatchObject({ org_id: 'org_a', name: 'orchestra' })
    expect(board).toMatchObject({ org_id: 'org_a', project_id: project.id, name: 'orchestra' })
  })

  it('uses an explicit board name when given', async () => {
    const sql = (await hubTestSql()) as HubSqlPool
    await seedOrg(sql, 'org_a')

    const { board } = await createProject(sql, { orgId: 'org_a', name: 'orchestra', boardName: 'Roadmap' })
    expect(board.name).toBe('Roadmap')
  })

  it('a duplicate project name in the same org is a ConflictError, not a raw driver error', async () => {
    const sql = (await hubTestSql()) as HubSqlPool
    await seedOrg(sql, 'org_a')
    await createProject(sql, { orgId: 'org_a', name: 'orchestra' })

    await expect(createProject(sql, { orgId: 'org_a', name: 'orchestra' })).rejects.toBeInstanceOf(ConflictError)
  })

  it('the same project name in a DIFFERENT org is fine — the constraint is per-org', async () => {
    const sql = (await hubTestSql()) as HubSqlPool
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')
    await createProject(sql, { orgId: 'org_a', name: 'orchestra' })

    await expect(createProject(sql, { orgId: 'org_b', name: 'orchestra' })).resolves.toMatchObject({
      project: { org_id: 'org_b' },
    })
  })

  it('an empty or over-long name is a ValidationError, and writes nothing', async () => {
    const sql = (await hubTestSql()) as HubSqlPool
    await seedOrg(sql, 'org_a')

    await expect(createProject(sql, { orgId: 'org_a', name: '  ' })).rejects.toBeInstanceOf(ValidationError)
    await expect(createProject(sql, { orgId: 'org_a', name: 'x'.repeat(121) })).rejects.toBeInstanceOf(ValidationError)
    expect(await listBoards(sql, 'org_a')).toEqual([])
  })
})

describe('ensureDefaultProject', () => {
  it('creates a default project and board for an org with none', async () => {
    const sql = (await hubTestSql()) as HubSqlPool
    await seedOrg(sql, 'org_a')

    const created = await ensureDefaultProject(sql, 'org_a')
    expect(created?.project.name).toBe(DEFAULT_PROJECT_NAME)
    expect(await listBoards(sql, 'org_a')).toHaveLength(1)
  })

  it('is idempotent — a replayed webhook never produces a second default board', async () => {
    const sql = (await hubTestSql()) as HubSqlPool
    await seedOrg(sql, 'org_a')

    await ensureDefaultProject(sql, 'org_a')
    const second = await ensureDefaultProject(sql, 'org_a')

    expect(second).toBeNull()
    expect(await listBoards(sql, 'org_a')).toHaveLength(1)
  })

  it('does nothing for an org that already made its own project', async () => {
    const sql = (await hubTestSql()) as HubSqlPool
    await seedOrg(sql, 'org_a')
    await createProject(sql, { orgId: 'org_a', name: 'mine' })

    expect(await ensureDefaultProject(sql, 'org_a')).toBeNull()
    expect((await listBoards(sql, 'org_a')).map((b) => b.name)).toEqual(['mine'])
  })
})

describe('organization.created seeds a default board', () => {
  function sign(secret: string, msgId: string, timestamp: Date, body: string) {
    const wh = new Webhook(secret)
    return {
      'svix-id': msgId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': wh.sign(msgId, timestamp, body),
      'content-type': 'application/json',
    }
  }

  async function deliver(server: FastifyInstance, body: string, msgId = `msg_${randomUUID()}`) {
    return server.inject({
      method: 'POST', url: '/webhooks/clerk',
      headers: sign(WEBHOOK_SECRET, msgId, new Date(), body), payload: body,
    })
  }

  const orgCreated = (id: string) => JSON.stringify({
    type: 'organization.created', object: 'event', data: { id, name: 'Acme', slug: `acme-${id}` },
  })

  it('a new Clerk org gets a board without anyone asking — nobody is ever stranded with zero boards', async () => {
    const hub = await projectFixture()

    const response = await deliver(hub.server, orgCreated('clerk_org_new'))
    expect(response.statusCode).toBe(200)

    const org = await hub.sql.query<{ id: string }>('SELECT id FROM orgs WHERE clerk_org_id = $1', ['clerk_org_new'])
    const boards = await listBoards(hub.sql, org.rows[0].id)
    expect(boards).toHaveLength(1)
    expect(boards[0].project_name).toBe(DEFAULT_PROJECT_NAME)
  })

  it('replaying the same organization.created (Clerk retries) still yields exactly one board', async () => {
    const hub = await projectFixture()
    const body = orgCreated('clerk_org_replay')

    await deliver(hub.server, body)
    await deliver(hub.server, body)
    await deliver(hub.server, body, `msg_${randomUUID()}`)

    const org = await hub.sql.query<{ id: string }>('SELECT id FROM orgs WHERE clerk_org_id = $1', ['clerk_org_replay'])
    expect(await listBoards(hub.sql, org.rows[0].id)).toHaveLength(1)
  })

  it('organization.updated never seeds a board — only creation does', async () => {
    const hub = await projectFixture()
    const body = JSON.stringify({
      type: 'organization.updated', object: 'event',
      data: { id: 'clerk_org_updated', name: 'Acme', slug: 'acme-updated' },
    })

    await deliver(hub.server, body)

    const org = await hub.sql.query<{ id: string }>('SELECT id FROM orgs WHERE clerk_org_id = $1', ['clerk_org_updated'])
    expect(await listBoards(hub.sql, org.rows[0].id)).toEqual([])
  })
})

describe('POST /orgs/:orgId/projects and GET /orgs/:orgId/boards', () => {
  it('a signed-in member creates a project and immediately sees its board in the listing', async () => {
    const hub = await projectFixture()

    const created = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/projects',
      headers: hub.auth, payload: { name: 'orchestra' },
    })
    expect(created.statusCode).toBe(201)
    const boardId = created.json().board.id

    const listed = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/orgs/org_a/boards', headers: hub.auth,
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().boards.map((b: any) => b.id)).toEqual([boardId])
  })

  /** The end-to-end gap C1 describes: with a board id in hand, an op that needs one works. */
  it('the created board is a usable target for a write op from a daemon', async () => {
    const hub = await projectFixture()
    const created = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/projects',
      headers: hub.auth, payload: { name: 'orchestra' },
    })
    const boardId = created.json().board.id
    const { token } = await mintDeviceToken(hub.sql, { orgId: 'org_a', name: 'laptop' })

    const op = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/ops',
      headers: { authorization: `Bearer ${token}` },
      payload: { op: 'card.create', payload: { board_id: boardId, title: 'first card' } },
    })

    expect(op.statusCode).toBe(200)
    expect(op.json().result).toMatchObject({ board_id: boardId, title: 'first card' })
  })

  it('a duplicate project name answers 409, not 500', async () => {
    const hub = await projectFixture()
    const payload = { name: 'orchestra' }
    await hub.server.inject({ method: 'POST', url: '/api/v1/hub/orgs/org_a/projects', headers: hub.auth, payload })

    const second = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/projects', headers: hub.auth, payload,
    })
    expect(second.statusCode).toBe(409)
  })

  it('a missing name answers 400', async () => {
    const hub = await projectFixture()
    const response = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/projects', headers: hub.auth, payload: {},
    })
    expect(response.statusCode).toBe(400)
  })

  it('a device token cannot create a project — Clerk principals only', async () => {
    const hub = await projectFixture()
    const { token } = await mintDeviceToken(hub.sql, { orgId: 'org_a', name: 'laptop' })

    const response = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/projects',
      headers: { authorization: `Bearer ${token}` }, payload: { name: 'sneaky' },
    })

    expect(response.statusCode).toBe(403)
    expect(await listBoards(hub.sql, 'org_a')).toEqual([])
  })

  it('a member of another org cannot create a project here, and cannot list these boards', async () => {
    const hub = await projectFixture()
    await seedOrg(hub.sql, 'org_b', 'clerk_org_b')
    await seedUser(hub.sql, 'user_2', 'clerk_user_2')
    await seedMembership(hub.sql, 'mem_2', 'org_b', 'user_2')
    const outsider = { authorization: `Bearer ${fakeClerkToken('clerk_user_2', 'clerk_org_b')}` }

    const created = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/projects', headers: outsider, payload: { name: 'theirs' },
    })
    const listed = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/orgs/org_a/boards', headers: outsider,
    })

    expect(created.statusCode).toBe(403)
    expect(listed.statusCode).toBe(403)
  })

  it('boards listing is org-scoped — another org\'s boards never appear', async () => {
    const hub = await projectFixture()
    await seedOrg(hub.sql, 'org_b')
    await createProject(hub.sql, { orgId: 'org_b', name: 'not-yours' })
    await createProject(hub.sql, { orgId: 'org_a', name: 'yours' })

    const listed = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/orgs/org_a/boards', headers: hub.auth,
    })
    expect(listed.json().boards.map((b: any) => b.name)).toEqual(['yours'])
  })

  it('a never-subscribed org cannot create further projects (it is a write) but can still list its default board', async () => {
    const hub = await projectFixture({ subscribed: false })
    await ensureDefaultProject(hub.sql, 'org_a')

    const created = await hub.server.inject({
      method: 'POST', url: '/api/v1/hub/orgs/org_a/projects', headers: hub.auth, payload: { name: 'another' },
    })
    expect(created.statusCode).toBe(403)
    expect(created.json().error).toMatch(/no subscription/)

    const listed = await hub.server.inject({
      method: 'GET', url: '/api/v1/hub/orgs/org_a/boards', headers: hub.auth,
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().boards).toHaveLength(1)
  })
})
