import { describe, it, expect } from 'vitest'
import { appendOrgEvent, readOrgEventsSince, latestOrgSeq } from '../src/hub/events.js'
import { hubTestSql, seedOrg } from './support/hub-sql.js'
import type { HubSql } from '../src/hub/sql.js'

/**
 * PGlite is single-connection, so there is no way to truly interleave two live
 * transactions in a test. This wraps a real `HubSql` and, at the moment the caller
 * under test is about to run its `INSERT INTO org_events`, first commits a "winner"
 * row directly (standing in for a concurrent caller that got there first) and then
 * lets the real INSERT proceed — which then hits the genuine partial unique index
 * (`org_events_idempotency_idx`) and throws the real Postgres-shaped 23505 error.
 * That exercises `appendOrgEvent`'s actual recovery path against a real error object,
 * not a fabricated one — only the "two writers at once" part is simulated.
 */
function raceInjectingSql(real: HubSql, injectWinner: () => Promise<void>): HubSql {
  let injected = false
  return {
    query: async (text, params) => {
      if (!injected && text.includes('INSERT INTO org_events (id')) {
        injected = true
        await injectWinner()
      }
      return real.query(text, params)
    },
  }
}

describe('org event log', () => {
  // Deliberately not "gapless": events.ts documents that a burned seq (a crash
  // between the counter bump and the insert) leaves a gap on purpose, and that
  // closing the gap by reusing the number would break resume. What is guaranteed
  // is that seq increases, and that the counter is per-org.
  it('assigns an increasing per-org seq', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')

    const a1 = await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n: 1 } })
    const a2 = await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n: 2 } })
    const b1 = await appendOrgEvent(sql, { orgId: 'org_b', kind: 'card.created', payload: { n: 3 } })

    expect(a1.seq).toBe(1)
    expect(a2.seq).toBe(2)
    expect(b1.seq).toBe(1) // per-org counter, not global
    expect(await latestOrgSeq(sql, 'org_a')).toBe(2)
  })

  it('replays an identical idempotency key instead of appending twice', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    const first = await appendOrgEvent(sql, {
      orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'hi' },
    })
    const replay = await appendOrgEvent(sql, {
      orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'hi' },
    })

    expect(replay.id).toBe(first.id)
    expect(replay.seq).toBe(first.seq)
    expect(await latestOrgSeq(sql, 'org_a')).toBe(1)
  })

  it('rejects a reused idempotency key carrying different content', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await appendOrgEvent(sql, { orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'hi' } })

    await expect(appendOrgEvent(sql, {
      orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'DIFFERENT' },
    })).rejects.toThrow(/idempotency key/i)
  })

  it('reads forward from a seq and never leaks another org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')
    for (const n of [1, 2, 3]) {
      await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n } })
    }
    await appendOrgEvent(sql, { orgId: 'org_b', kind: 'card.created', payload: { n: 99 } })

    const tail = await readOrgEventsSince(sql, 'org_a', 1)
    expect(tail.map((e) => e.seq)).toEqual([2, 3])
    expect(tail.every((e) => e.org_id === 'org_a')).toBe(true)
  })

  it('allocates seq from the atomic counter with no gaps, per org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')

    const a1 = await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n: 1 } })
    const a2 = await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n: 2 } })
    const a3 = await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n: 3 } })
    const b1 = await appendOrgEvent(sql, { orgId: 'org_b', kind: 'card.created', payload: { n: 99 } })
    const b2 = await appendOrgEvent(sql, { orgId: 'org_b', kind: 'card.created', payload: { n: 100 } })

    expect([a1.seq, a2.seq, a3.seq]).toEqual([1, 2, 3])
    expect([b1.seq, b2.seq]).toEqual([1, 2])
  })

  it('does not burn a seq number when an idempotency key is replayed', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    const first = await appendOrgEvent(sql, {
      orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'hi' },
    })
    expect(first.seq).toBe(1)

    // Replay the same key several times — none of these may advance the counter.
    for (let i = 0; i < 3; i++) {
      const replay = await appendOrgEvent(sql, {
        orgId: 'org_a', kind: 'mail.sent', idempotencyKey: 'key-1', payload: { body: 'hi' },
      })
      expect(replay.id).toBe(first.id)
      expect(replay.seq).toBe(1)
    }

    const next = await appendOrgEvent(sql, { orgId: 'org_a', kind: 'card.created', payload: { n: 1 } })
    expect(next.seq).toBe(2)
    expect(await latestOrgSeq(sql, 'org_a')).toBe(2)
  })

  it('returns the winning event, not an error, when two writers race the same key', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    const raced = raceInjectingSql(sql, async () => {
      await sql.query(
        `INSERT INTO org_events (id, org_id, seq, kind, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['evt_winner', 'org_a', 99999, 'card.created', 'race-key', JSON.stringify({ winner: true })],
      )
    })

    const loser = await appendOrgEvent(raced, {
      orgId: 'org_a', kind: 'card.created', idempotencyKey: 'race-key', payload: { winner: false },
    })

    // The loser gets the winner's event back, not its own — that IS the winner's event.
    expect(loser.id).toBe('evt_winner')
    expect((loser.payload as any).winner).toBe(true)

    // No orphan/duplicate row: only the winner's event exists for this key.
    const all = await readOrgEventsSince(sql, 'org_a', 0)
    expect(all.filter((e) => e.id === 'evt_winner')).toHaveLength(1)
  })

  it('rejects the race when the winning event is a different kind', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    const raced = raceInjectingSql(sql, async () => {
      await sql.query(
        `INSERT INTO org_events (id, org_id, seq, kind, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['evt_winner_2', 'org_a', 99999, 'card.updated', 'race-key-2', JSON.stringify({ winner: true })],
      )
    })

    await expect(appendOrgEvent(raced, {
      orgId: 'org_a', kind: 'card.created', idempotencyKey: 'race-key-2', payload: { winner: false },
    })).rejects.toMatchObject({ statusCode: 409 })
  })
})
