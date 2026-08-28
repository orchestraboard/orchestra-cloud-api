import { describe, it, expect } from 'vitest'
import { registerAgent, heartbeat, sweepStalePresence, listAgents } from '../src/hub/presence.js'
import { createCard } from '../src/hub/cards.js'
import { readOrgEventsSince } from '../src/hub/events.js'
import { hubTestSql, seedOrg, seedBoard } from './support/hub-sql.js'

async function board() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  return sql
}

describe('hub presence', () => {
  it('registers an agent once and is idempotent by name', async () => {
    const sql = await board()
    const first = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })
    const again = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })

    expect(again.id).toBe(first.id)
    expect((await listAgents(sql, 'org_a')).length).toBe(1)
  })

  it('records state and a one-line activity, not a transcript', async () => {
    const sql = await board()
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })

    const beat = await heartbeat(sql, {
      orgId: 'org_a', agentId: agent.id, state: 'working', activity: 'editing src/server.ts',
    })
    expect(beat.state).toBe('working')
    expect(beat.activity).toBe('editing src/server.ts')
    expect(beat.last_heartbeat_at).not.toBeNull()
  })

  it('keeps heartbeats out of the replayable event log', async () => {
    const sql = await board()
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })
    await heartbeat(sql, { orgId: 'org_a', agentId: agent.id, state: 'working' })
    await heartbeat(sql, { orgId: 'org_a', agentId: agent.id, state: 'idle' })

    const events = await readOrgEventsSince(sql, 'org_a', 0)
    expect(events.map((e) => e.kind)).toEqual(['agent.registered'])
  })

  it('flips agents offline once heartbeats lapse past the TTL', async () => {
    const sql = await board()
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })
    await heartbeat(sql, { orgId: 'org_a', agentId: agent.id, state: 'working' })

    // Backdate the heartbeat rather than sleeping — tests must stay fast and deterministic.
    await sql.query("UPDATE agents SET last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1", [agent.id])

    const swept = await sweepStalePresence(sql, 'org_a', 45)
    expect(swept).toBe(1)
    expect((await listAgents(sql, 'org_a'))[0].state).toBe('offline')
  })

  it('does not flip agents whose heartbeat is still within the TTL', async () => {
    const sql = await board()
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })
    await heartbeat(sql, { orgId: 'org_a', agentId: agent.id, state: 'working' })

    // Backdate by 10s — well inside a 45s TTL, should stay online.
    await sql.query("UPDATE agents SET last_heartbeat_at = now() - interval '10 seconds' WHERE id = $1", [agent.id])

    const swept = await sweepStalePresence(sql, 'org_a', 45)
    expect(swept).toBe(0)
    expect((await listAgents(sql, 'org_a'))[0].state).toBe('working')
  })

  it('flips an agent that never heartbeat at all', async () => {
    const sql = await board()
    await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })

    const swept = await sweepStalePresence(sql, 'org_a', 45)
    expect(swept).toBe(1)
    expect((await listAgents(sql, 'org_a'))[0].state).toBe('offline')
  })

  it('rejects a state outside the union, and a missing one, with a 400', async () => {
    const sql = await board()
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })

    for (const state of ['not-a-real-state', undefined, null, 7, 'WORKING']) {
      const attempt = heartbeat(sql, { orgId: 'org_a', agentId: agent.id, state: state as any })
      await expect(attempt).rejects.toMatchObject({ statusCode: 400, code: 'validation_failed' })
    }

    // The bad heartbeats left no trace — state is still the registration default.
    expect((await listAgents(sql, 'org_a'))[0].state).toBe('idle')
  })

  it('404s a current_card_id from another org without touching the agent', async () => {
    const sql = await board()
    await seedOrg(sql, 'org_b')
    await seedBoard(sql, 'org_b', 'board_b')
    const foreign = await createCard(sql, { orgId: 'org_b', boardId: 'board_b', title: 'Other org card' })
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })

    const attempt = heartbeat(sql, {
      orgId: 'org_a', agentId: agent.id, state: 'working', currentCardId: foreign.id,
    })
    await expect(attempt).rejects.toMatchObject({ statusCode: 404, code: 'not_found' })

    // Nothing was written: no cross-org pointer, and the failed beat did not land.
    const after = (await listAgents(sql, 'org_a'))[0]
    expect(after.current_card_id).toBeNull()
    expect(after.last_heartbeat_at).toBeNull()
  })

  it('answers a foreign and a nonexistent current_card_id identically', async () => {
    const sql = await board()
    await seedOrg(sql, 'org_b')
    await seedBoard(sql, 'org_b', 'board_b')
    const foreign = await createCard(sql, { orgId: 'org_b', boardId: 'board_b', title: 'Other org card' })
    const agent = await registerAgent(sql, { orgId: 'org_a', boardId: 'board_1', name: 'alice-agent' })

    const beat = (cardId: string) => heartbeat(sql, {
      orgId: 'org_a', agentId: agent.id, state: 'working', currentCardId: cardId,
    }).catch((error) => ({ statusCode: error.statusCode, code: error.code, message: error.message }))

    expect(await beat(foreign.id)).toEqual(await beat('card_does-not-exist'))
  })
})
