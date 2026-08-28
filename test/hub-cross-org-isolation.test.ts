import { describe, it, expect, afterEach } from 'vitest'
import { hubFixture, closeHubServers } from './support/hub-fixture.js'
import { seedOrg, seedBoard } from './support/hub-sql.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import { createCard } from '../src/hub/cards.js'
import { sendMail } from '../src/hub/mail.js'

afterEach(async () => { await closeHubServers() })

describe('hub cross-org isolation', () => {
  it('a device token cannot read, write, or stream another org', async () => {
    const hub = await hubFixture()
    await seedOrg(hub.sql, 'org_b')
    await seedBoard(hub.sql, 'org_b', 'board_b')
    const intruder = await mintDeviceToken(hub.sql, { orgId: 'org_b', name: 'intruder' })

    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'Confidential' })
    await sendMail(hub.sql, {
      orgId: hub.orgId, boardId: hub.boardId, fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'secret',
    })

    const headers = { authorization: `Bearer ${intruder.token}` }
    const attempts = [
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`, headers }),
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/agents`, headers }),
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/mail/inbox?agent=bob-agent`, headers }),
      hub.server.inject({ method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/sync?since=0&catchup=1`, headers }),
      hub.server.inject({
        method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers,
        payload: { op: 'card.create', payload: { board_id: hub.boardId, title: 'Injected' } },
      }),
    ]

    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode).toBe(403)
    }
  })

  it('a valid token cannot reference another org\'s entity ids through the ops endpoint', async () => {
    // The isolation test above only varies the TOKEN, which is why unchecked
    // foreign-key payload fields survived review: here the token is legitimately
    // org_a's and it is the ID that is foreign. Every op that accepts an entity id
    // must answer 404 — the same answer a nonexistent id gets, so the response
    // cannot be used to probe for rows in other orgs.
    const hub = await hubFixture()
    await seedOrg(hub.sql, 'org_b')
    await seedBoard(hub.sql, 'org_b', 'board_b')
    const foreignCard = await createCard(hub.sql, { orgId: 'org_b', boardId: 'board_b', title: 'Other org card' })
    const foreignMail = await sendMail(hub.sql, {
      orgId: 'org_b', boardId: 'board_b', fromAgent: 'mallory', toAgent: 'eve', body: 'other org mail',
    })

    const registered = await hub.server.inject({
      method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(),
      payload: { op: 'agent.register', payload: { board_id: hub.boardId, name: 'agent-one' } },
    })
    const agentId = registered.json().result.id

    const ops = [
      { op: 'card.create', payload: { board_id: 'board_b', title: 'Injected' } },
      { op: 'card.update', payload: { card_id: foreignCard.id, expected_version: 1, title: 'Injected' } },
      { op: 'card.move', payload: { card_id: foreignCard.id, expected_version: 1, column: 'done' } },
      { op: 'card.claim', payload: { card_id: foreignCard.id, agent: 'agent-one' } },
      { op: 'mail.send', payload: { board_id: hub.boardId, from_agent: 'a', body: 'x', card_id: foreignCard.id } },
      { op: 'mail.send', payload: { board_id: hub.boardId, from_agent: 'a', body: 'x', reply_to: foreignMail.id } },
      { op: 'agent.register', payload: { board_id: 'board_b', name: 'agent-two' } },
      { op: 'agent.heartbeat', payload: { agent_id: agentId, state: 'working', current_card_id: foreignCard.id } },
    ]

    for (const body of ops) {
      const response = await hub.server.inject({
        method: 'POST', url: `/api/v1/hub/orgs/${hub.orgId}/ops`, headers: hub.auth(), payload: body,
      })
      expect(response.statusCode, `${body.op} ${JSON.stringify(body.payload)}`).toBe(404)
      expect(response.json().code).toBe('not_found')
    }

    // Nothing crossed over: org_b is exactly as it was.
    const otherOrg = await hub.sql.query('SELECT id FROM mail WHERE org_id = $1', ['org_b'])
    expect(otherOrg.rows.map((row: any) => row.id)).toEqual([foreignMail.id])
    const mine = await hub.sql.query('SELECT card_id FROM mail WHERE org_id = $1', [hub.orgId])
    expect(mine.rows).toEqual([])
  })

  it('an org-scoped read never returns another org\'s rows even with a valid token', async () => {
    const hub = await hubFixture()
    await seedOrg(hub.sql, 'org_b')
    await seedBoard(hub.sql, 'org_b', 'board_b')
    await createCard(hub.sql, { orgId: 'org_b', boardId: 'board_b', title: 'Other org card' })
    await createCard(hub.sql, { orgId: hub.orgId, boardId: hub.boardId, title: 'My card' })

    const response = await hub.server.inject({
      method: 'GET', url: `/api/v1/hub/orgs/${hub.orgId}/cards`, headers: hub.auth(),
    })
    const titles = response.json().cards.map((c: any) => c.title)
    expect(titles).toEqual(['My card'])
  })
})
