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
