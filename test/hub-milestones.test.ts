import { describe, it, expect } from 'vitest'
import { createCard, getCard, moveCard, setCardMilestone } from '../src/hub/cards.js'
import { createMilestone, deleteMilestone, listMilestones, updateMilestone } from '../src/hub/milestones.js'
import { readOrgEventsSince } from '../src/hub/events.js'
import { hubTestSql, seedOrg, seedBoard } from './support/hub-sql.js'

async function board() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  return sql
}

describe('hub milestones', () => {
  it('creates, lists, updates with optimistic versioning, and logs events', async () => {
    const sql = await board()
    const milestone = await createMilestone(sql, {
      orgId: 'org_a', boardId: 'board_1', title: 'v1 launch', description: 'ship it',
    })
    expect(milestone.status).toBe('open')
    expect(milestone.version).toBe(1)

    const updated = await updateMilestone(sql, {
      orgId: 'org_a', milestoneId: milestone.id, expectedVersion: 1, status: 'shipped',
    })
    expect(updated.status).toBe('shipped')
    expect(updated.version).toBe(2)

    // The cross-machine race: a second writer still at version 1 must 409, not clobber.
    await expect(updateMilestone(sql, {
      orgId: 'org_a', milestoneId: milestone.id, expectedVersion: 1, title: 'stale',
    })).rejects.toMatchObject({ statusCode: 409 })

    expect(await listMilestones(sql, 'org_a')).toHaveLength(1)
    const events = await readOrgEventsSince(sql, 'org_a', 0)
    expect(events.map((e) => e.kind)).toEqual(['milestone.created', 'milestone.updated'])
  })

  it('attaches a card via card.milestone, detaches on milestone delete, and scopes ids to the org', async () => {
    const sql = await board()
    const milestone = await createMilestone(sql, { orgId: 'org_a', boardId: 'board_1', title: 'v1' })
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Step' })

    const attached = await setCardMilestone(sql, {
      orgId: 'org_a', cardId: card.id, expectedVersion: card.version, milestoneId: milestone.id,
    })
    expect(attached.milestone_id).toBe(milestone.id)
    expect(attached.version).toBe(card.version + 1)

    // A milestone id from another org must read as nonexistent, never as a hint.
    await seedOrg(sql, 'org_b')
    await seedBoard(sql, 'org_b', 'board_b')
    const foreign = await createMilestone(sql, { orgId: 'org_b', boardId: 'board_b', title: 'theirs' })
    await expect(setCardMilestone(sql, {
      orgId: 'org_a', cardId: card.id, expectedVersion: attached.version, milestoneId: foreign.id,
    })).rejects.toMatchObject({ statusCode: 404 })

    await deleteMilestone(sql, { orgId: 'org_a', milestoneId: milestone.id })
    const after = await getCard(sql, 'org_a', card.id)
    expect(after?.milestone_id).toBeNull()
    const kinds = (await readOrgEventsSince(sql, 'org_a', 0)).map((e) => e.kind)
    expect(kinds).toContain('milestone.deleted')
  })

  it('accepts blocked as a card column', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Stuck' })
    const moved = await moveCard(sql, {
      orgId: 'org_a', cardId: card.id, expectedVersion: 1, column: 'blocked',
    })
    expect(moved.column).toBe('blocked')
  })
})
