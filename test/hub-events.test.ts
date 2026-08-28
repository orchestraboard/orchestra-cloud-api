import { describe, it, expect } from 'vitest'
import { appendOrgEvent, readOrgEventsSince, latestOrgSeq } from '../src/hub/events.js'
import { hubTestSql, seedOrg } from './support/hub-sql.js'

describe('org event log', () => {
  it('assigns a gapless monotonic seq per org', async () => {
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
})
