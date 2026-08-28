import { describe, it, expect, afterEach } from 'vitest'
import { entitlementsFor, assertOrgWritable, assertAgentCapacity } from '../src/hub/entitlements.js'
import { registerAgent, heartbeat } from '../src/hub/presence.js'
import { ForbiddenError } from '../src/hub/errors.js'
import { hubTestSql, seedOrg, seedBoard } from './support/hub-sql.js'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import type { HubSql } from '../src/hub/sql.js'

afterEach(async () => { await closeHubServers() })

/** Inserts (or upserts) a `subscriptions` row with only the columns a test cares
 * about — everything else takes the schema default (0 / false / 'none'). */
async function seedSubscription(
  sql: HubSql, orgId: string,
  fields: Partial<{
    tier: 'cloud' | 'business' | 'none'
    seatsIncluded: number; seatsPurchased: number; agentPacks: number; ssoEnabled: boolean
  }>,
): Promise<void> {
  await sql.query(
    `INSERT INTO subscriptions (org_id, tier, seats_included, seats_purchased, agent_packs, sso_enabled)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      orgId, fields.tier ?? 'none', fields.seatsIncluded ?? 0, fields.seatsPurchased ?? 0,
      fields.agentPacks ?? 0, fields.ssoEnabled ?? false,
    ],
  )
}

describe('entitlementsFor', () => {
  it('cloud: seats = 3 base + purchased; concurrent agents = 3 x seats + 10 x packs', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedSubscription(sql, 'org_a', { tier: 'cloud', seatsIncluded: 3, seatsPurchased: 4, agentPacks: 2 })

    const entitlement = await entitlementsFor(sql, 'org_a')

    expect(entitlement.seats).toBe(7) // 3 + 4
    expect(entitlement.concurrentAgents).toBe(41) // 3*7 + 10*2
  })

  it('cloud with no extra seats/packs: seats = 3, concurrent agents = 9', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedSubscription(sql, 'org_a', { tier: 'cloud', seatsIncluded: 3, seatsPurchased: 0, agentPacks: 0 })

    const entitlement = await entitlementsFor(sql, 'org_a')

    expect(entitlement.seats).toBe(3)
    expect(entitlement.concurrentAgents).toBe(9)
  })

  it('cloud passes sso_enabled straight through', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedSubscription(sql, 'org_a', { tier: 'cloud', seatsIncluded: 3, ssoEnabled: true })

    expect((await entitlementsFor(sql, 'org_a')).sso).toBe(true)
  })

  it('business: seats = purchased seats (no included base)', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedSubscription(sql, 'org_a', { tier: 'business', seatsPurchased: 15 })

    const entitlement = await entitlementsFor(sql, 'org_a')

    expect(entitlement.seats).toBe(15)
  })

  it('business: seats floor at the 10-seat minimum even if cached data somehow drifted under it', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    // Stripe's price enforces a 10-seat minimum at checkout — this seeds a value
    // beneath it directly to prove the code itself floors, not just Stripe.
    await seedSubscription(sql, 'org_a', { tier: 'business', seatsPurchased: 4 })

    expect((await entitlementsFor(sql, 'org_a')).seats).toBe(10)
  })

  it('business: concurrent agents uses the same 3-per-seat ratio as Cloud (no defined agent-pack equivalent)', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedSubscription(sql, 'org_a', { tier: 'business', seatsPurchased: 12 })

    expect((await entitlementsFor(sql, 'org_a')).concurrentAgents).toBe(36) // 3 * 12
  })

  it("'none' with no subscriptions row at all falls back to orgs.seat_cap, never zero", async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a') // no subscription row seeded — a brand-new, never-subscribed org
    await sql.query('UPDATE orgs SET seat_cap = 5 WHERE id = $1', ['org_a'])

    const entitlement = await entitlementsFor(sql, 'org_a')

    expect(entitlement.seats).toBe(5)
    expect(entitlement.concurrentAgents).toBe(15) // 3 * 5, not 0 and not unlimited
    expect(entitlement.sso).toBe(false)
  })

  it("'none' with a brand-new, never-synced subscriptions row (schema defaults) also falls back to seat_cap", async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query('UPDATE orgs SET seat_cap = 8 WHERE id = $1', ['org_a'])
    await seedSubscription(sql, 'org_a', {}) // tier 'none', everything else 0/false — the schema defaults

    expect((await entitlementsFor(sql, 'org_a')).seats).toBe(8)
  })

  it("'none' after a prior healthy sync preserves the cached seats/packs rather than zeroing them", async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    // Mirrors what syncSubscriptionFromStripe actually leaves behind on an
    // unrecognized resync: tier flips to 'none', but seats/packs/sso from the last
    // healthy sync are untouched (see billing.ts's own comment on this).
    await seedSubscription(sql, 'org_a', {
      tier: 'none', seatsIncluded: 3, seatsPurchased: 2, agentPacks: 1, ssoEnabled: true,
    })

    const entitlement = await entitlementsFor(sql, 'org_a')

    expect(entitlement.seats).toBe(5) // 3 + 2, the previously-granted amount
    expect(entitlement.concurrentAgents).toBe(25) // 3*5 + 10*1
    expect(entitlement.sso).toBe(true)
  })

  it('status mirrors orgs.status, the same field assertOrgWritable reads', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query("UPDATE orgs SET status = 'suspended' WHERE id = $1", ['org_a'])

    expect((await entitlementsFor(sql, 'org_a')).status).toBe('suspended')
  })

  it('never touches Stripe — only takes a sql handle and an org id', async () => {
    // Structural proof, not a mock assertion: entitlementsFor's signature has no
    // Stripe client parameter at all, so it cannot make a live call no matter what
    // Stripe is doing. If Stripe is down, this still resolves from cached columns.
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedSubscription(sql, 'org_a', { tier: 'cloud', seatsIncluded: 3 })

    await expect(entitlementsFor(sql, 'org_a')).resolves.toBeDefined()
  })
})

describe('assertOrgWritable', () => {
  it('does not throw for an active org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await expect(assertOrgWritable(sql, 'org_a')).resolves.toBeUndefined()
  })

  it('throws ForbiddenError for a suspended org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await sql.query("UPDATE orgs SET status = 'suspended' WHERE id = $1", ['org_a'])

    await expect(assertOrgWritable(sql, 'org_a')).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('HTTP: a suspended org refuses every op through the ops endpoint (403)', async () => {
    const hub = await hubFixture()
    await hub.sql.query("UPDATE orgs SET status = 'suspended' WHERE id = $1", [hub.orgId])

    const ops = [
      { op: 'card.create', payload: { board_id: hub.boardId, title: 'x' } },
      { op: 'mail.send', payload: { board_id: hub.boardId, from_agent: 'a', body: 'x' } },
      { op: 'agent.register', payload: { board_id: hub.boardId, name: 'agent-one' } },
    ]
    for (const body of ops) {
      const response = await hub.server.inject({
        method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(), payload: body,
      })
      expect(response.statusCode, body.op).toBe(403)
      expect(response.json().code).toBe('forbidden')
    }
  })

  it('HTTP: a suspended org still serves reads (cards, agents, mail inbox)', async () => {
    const hub = await hubFixture()
    // Seed a card and mail while active, then suspend, then read.
    await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Before suspension' } },
    })
    await hub.sql.query("UPDATE orgs SET status = 'suspended' WHERE id = $1", [hub.orgId])

    const reads = await Promise.all([
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`, headers: hub.auth() }),
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/agents`, headers: hub.auth() }),
      hub.server.inject({
        method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/mail/inbox?agent=bob-agent`, headers: hub.auth(),
      }),
    ])
    for (const response of reads) expect(response.statusCode).toBe(200)
    expect(reads[0].json().cards.map((c: any) => c.title)).toEqual(['Before suspension'])
  })
})

describe('assertAgentCapacity', () => {
  async function orgWithCloudCapacity(seats: number, packs = 0) {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedBoard(sql, 'org_a', 'board_1')
    await seedSubscription(sql, 'org_a', { tier: 'cloud', seatsIncluded: 3, seatsPurchased: seats - 3, agentPacks: packs })
    return sql
  }

  it('does not throw while under capacity', async () => {
    const sql = await orgWithCloudCapacity(3) // cap = 9
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'agent-1' })

    await expect(assertAgentCapacity(sql, 'org_a')).resolves.toBeUndefined()
  })

  it('an org exactly AT its cap can still operate (existing agents keep heartbeating)', async () => {
    const sql = await orgWithCloudCapacity(1) // cap = 3
    const agents = await Promise.all([
      registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a1' }),
      registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a2' }),
      registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a3' }),
    ])
    // Now at exactly 3/3. Existing agents are unaffected by the cap.
    await expect(
      heartbeat(sql, { orgId: 'org_a', agentId: agents[0].id, state: 'working', activity: 'still going' }),
    ).resolves.toMatchObject({ state: 'working' })
  })

  it('registering a NEW agent beyond capacity is refused with a clear, actionable error naming the limit', async () => {
    const sql = await orgWithCloudCapacity(1) // cap = 3
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a1' })
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a2' })
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a3' })

    await expect(
      registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a4' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a4' }),
    ).rejects.toThrow('3/3')
    // Names what to buy, not just "no".
    await expect(
      registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a4' }),
    ).rejects.toThrow(/agent pack|seats/)
  })

  it('re-registering an existing agent (idempotent reconnect) succeeds even when the org is exactly at cap', async () => {
    const sql = await orgWithCloudCapacity(1) // cap = 3
    const first = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a1' })
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a2' })
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a3' })
    // Org is now at exactly 3/3. A daemon reconnecting under an already-registered
    // name must not be refused — it adds no new agent.
    const again = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a1' })

    expect(again.id).toBe(first.id)
  })

  it('a lapsed (offline) agent frees its slot for a new registration', async () => {
    const sql = await orgWithCloudCapacity(1) // cap = 3
    const a1 = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a1' })
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a2' })
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a3' })
    await sql.query("UPDATE agents SET state = 'offline' WHERE id = $1", [a1.id])

    await expect(
      registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'a4' }),
    ).resolves.toMatchObject({ name: 'a4' })
  })

  it('HTTP: agent.register beyond capacity answers 403 with the limit in the message', async () => {
    const hub = await hubFixture()
    await seedSubscription(hub.sql, hub.orgId, { tier: 'cloud', seatsIncluded: 3, seatsPurchased: 0 }) // cap = 9
    for (let i = 0; i < 9; i++) {
      const response = await hub.server.inject({
        method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
        payload: { op: 'agent.register', payload: { board_id: hub.boardId, name: `agent-${i}` } },
      })
      expect(response.statusCode, `agent-${i}`).toBe(200)
    }

    const overCap = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'agent.register', payload: { board_id: hub.boardId, name: 'agent-over-cap' } },
    })
    expect(overCap.statusCode).toBe(403)
    expect(overCap.json().error).toContain('9/9')
  })
})

describe('GET /orgs/:orgId/entitlements', () => {
  it('reports entitled vs. live usage, and is reachable even when suspended', async () => {
    const hub = await hubFixture()
    await seedSubscription(hub.sql, hub.orgId, { tier: 'cloud', seatsIncluded: 3, seatsPurchased: 1, agentPacks: 0 })
    await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'agent.register', payload: { board_id: hub.boardId, name: 'agent-1' } },
    })
    await hub.sql.query("UPDATE orgs SET status = 'suspended' WHERE id = $1", [hub.orgId])

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/entitlements`, headers: hub.auth(),
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('suspended')
    expect(body.tier).toBe('cloud')
    expect(body.seats).toEqual({ used: 0, entitled: 4 }) // no memberships seeded in this fixture
    expect(body.agents).toEqual({ used: 1, entitled: 12 }) // 3*4 + 10*0
  })
})
