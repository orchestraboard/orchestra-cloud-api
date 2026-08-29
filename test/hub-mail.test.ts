import { describe, it, expect } from 'vitest'
import { sendMail, drainInbox } from '../src/hub/mail.js'
import { createCard } from '../src/hub/cards.js'
import { readOrgEventsSince } from '../src/hub/events.js'
import { hubTestSql, seedOrg, seedBoard } from './support/hub-sql.js'

async function board() {
  const sql = await hubTestSql()
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  return sql
}

describe('hub mail', () => {
  it('sends agent-to-agent mail across machines and logs mail.sent', async () => {
    const sql = await board()
    const mail = await sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'who owns #4?',
    })

    expect(mail.to_agent).toBe('bob-agent')
    expect(mail.delivered_at).toBeNull()

    const events = await readOrgEventsSince(sql, 'org_a', 0)
    expect(events.map((e) => e.kind)).toEqual(['mail.sent'])
  })

  it('delivers each message once', async () => {
    const sql = await board()
    await sendMail(sql, { orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'one' })
    await sendMail(sql, { orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'two' })

    const first = await drainInbox(sql, 'org_a', 'bob-agent')
    expect(first.map((m) => m.body)).toEqual(['one', 'two'])

    const second = await drainInbox(sql, 'org_a', 'bob-agent')
    expect(second).toEqual([])
  })

  it('does not deliver another agent\'s or another org\'s mail', async () => {
    const sql = await board()
    await seedOrg(sql, 'org_b')
    await sendMail(sql, { orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'private' })

    expect(await drainInbox(sql, 'org_a', 'carol-agent')).toEqual([])
    expect(await drainInbox(sql, 'org_b', 'bob-agent')).toEqual([])
  })

  it('rejects an empty body', async () => {
    const sql = await board()
    await expect(sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: '   ',
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('replays sendMail idempotently: one row inserted, original returned, no new event', async () => {
    const sql = await board()
    const first = await sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent',
      body: 'who owns #4?', idempotencyKey: 'idem-1',
    })
    const replay = await sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent',
      body: 'who owns #4?', idempotencyKey: 'idem-1',
    })

    // The driver hands back `created_at` as a native Date on the original insert
    // but as a JSON-round-tripped string when replayed from the stored event
    // payload, so compare fields individually rather than deep-equal the row.
    expect(replay.id).toBe(first.id)
    expect(replay.body).toBe(first.body)
    expect(replay.to_agent).toBe(first.to_agent)
    expect(new Date(replay.created_at).getTime()).toBe(new Date(first.created_at).getTime())

    const all = await sql.query('SELECT * FROM mail WHERE org_id = $1', ['org_a'])
    expect(all.rowCount).toBe(1)

    const events = await readOrgEventsSince(sql, 'org_a', 0)
    expect(events.map((e) => e.kind)).toEqual(['mail.sent'])
  })

  it('rejects an idempotency key already used for a different kind of operation', async () => {
    const sql = await board()
    await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'x', idempotencyKey: 'idem-2' })

    await expect(sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent',
      body: 'hi', idempotencyKey: 'idem-2',
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('404s a card_id or reply_to from another org, writing nothing', async () => {
    const sql = await board()
    await seedOrg(sql, 'org_b')
    await seedBoard(sql, 'org_b', 'board_b')
    const foreignCard = await createCard(sql, { orgId: 'org_b', boardId: 'board_b', title: 'Other org card' })
    const foreignMail = await sendMail(sql, {
      orgId: 'org_b', boardId: 'board_b', fromAgent: 'mallory', toAgent: 'eve', body: 'other org mail',
    })

    const base = { orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'hi' }
    await expect(sendMail(sql, { ...base, cardId: foreignCard.id }))
      .rejects.toMatchObject({ statusCode: 404, code: 'not_found' })
    await expect(sendMail(sql, { ...base, replyTo: foreignMail.id }))
      .rejects.toMatchObject({ statusCode: 404, code: 'not_found' })

    // No cross-tenant reference was written, and no event was appended for either.
    const mine = await sql.query('SELECT * FROM mail WHERE org_id = $1', ['org_a'])
    expect(mine.rowCount).toBe(0)
    expect(await readOrgEventsSince(sql, 'org_a', 0)).toEqual([])
  })

  it('answers a foreign id and a nonexistent id identically, leaking no existence', async () => {
    const sql = await board()
    await seedOrg(sql, 'org_b')
    await seedBoard(sql, 'org_b', 'board_b')
    const foreignCard = await createCard(sql, { orgId: 'org_b', boardId: 'board_b', title: 'Other org card' })

    const base = { orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent', body: 'hi' }
    const attempt = (cardId: string) => sendMail(sql, { ...base, cardId })
      .catch((error) => ({ statusCode: error.statusCode, code: error.code, message: error.message }))

    // A 200-vs-500 split here was an existence oracle spanning every org on the hub.
    expect(await attempt(foreignCard.id)).toEqual(await attempt('card_does-not-exist'))
  })

  it('accepts a card_id and reply_to from this org', async () => {
    const sql = await board()
    const card = await createCard(sql, { orgId: 'org_a', boardId: 'board_1', title: 'Mine' })
    const first = await sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'alice-agent', toAgent: 'bob-agent',
      body: 'who owns this?', cardId: card.id,
    })
    const reply = await sendMail(sql, {
      orgId: 'org_a', boardId: 'board_1', fromAgent: 'bob-agent', toAgent: 'alice-agent',
      body: 'I do', cardId: card.id, replyTo: first.id,
    })

    expect(first.card_id).toBe(card.id)
    expect(reply.reply_to).toBe(first.id)
  })
})
