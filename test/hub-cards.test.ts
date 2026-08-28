import { describe, it, expect } from 'vitest'
import { createCard, updateCard, moveCard, claimCard, getCard } from '../src/hub/cards.js'
import { readOrgEventsSince } from '../src/hub/events.js'
import { hubTestSql, seedOrg, seedBoard } from './support/hub-sql.js'

async function board() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  return sql
}

describe('hub card ops', () => {
  it('creates a card at version 1 with a per-board number and logs an event', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'First' })

    expect(card.number).toBe(1)
    expect(card.version).toBe(1)
    expect(card.column).toBe('backlog')

    const second = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Second' })
    expect(second.number).toBe(2)

    const events = await readOrgEventsSince(sql, 'org_a', 0)
    expect(events.map((e) => e.kind)).toEqual(['card.created', 'card.created'])
  })

  it('bumps version on update and logs card.updated', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'First' })

    const updated = await updateCard(sql, {
      orgId: 'org_a', cardId: card.id, expectedVersion: card.version, title: 'Renamed',
    })
    expect(updated.title).toBe('Renamed')
    expect(updated.version).toBe(2)
  })

  it('rejects a stale write with 409 and hands back current state', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'First' })
    await moveCard(sql, { orgId: 'org_a', cardId: card.id, expectedVersion: 1, column: 'in_progress' })

    // Second writer still believes it is version 1 — this is the cross-machine race.
    const stale = updateCard(sql, {
      orgId: 'org_a', cardId: card.id, expectedVersion: 1, title: 'Too late',
    })
    await expect(stale).rejects.toMatchObject({ statusCode: 409 })
    await stale.catch((error: any) => {
      expect(error.current.version).toBe(2)
      expect(error.current.column).toBe('in_progress')
    })

    const fresh = await getCard(sql, 'org_a', card.id)
    expect(fresh?.title).toBe('First') // the losing write did not land
  })

  it('lets exactly one agent claim an unowned card', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Contested' })

    const winner = await claimCard(sql, { orgId: 'org_a', cardId: card.id, agent: 'agent-one' })
    expect(winner.owner_agent).toBe('agent-one')

    await expect(
      claimCard(sql, { orgId: 'org_a', cardId: card.id, agent: 'agent-two' }),
    ).rejects.toMatchObject({ statusCode: 409 })

    const fresh = await getCard(sql, 'org_a', card.id)
    expect(fresh?.owner_agent).toBe('agent-one')
  })

  it('treats a re-claim by the current owner as a no-op success', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Mine' })
    await claimCard(sql, { orgId: 'org_a', cardId: card.id, agent: 'agent-one' })

    const again = await claimCard(sql, { orgId: 'org_a', cardId: card.id, agent: 'agent-one' })
    expect(again.owner_agent).toBe('agent-one')
  })

  it('refuses to read or write another org\'s card', async () => {
    const sql = await board()
    await seedOrg(sql, 'org_b')
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Private' })

    expect(await getCard(sql, 'org_b', card.id)).toBeNull()
    await expect(
      updateCard(sql, { orgId: 'org_b', cardId: card.id, expectedVersion: 1, title: 'Stolen' }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
