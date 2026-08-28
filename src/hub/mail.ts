import { randomUUID } from 'node:crypto'
import { appendOrgEvent, replayIfIdempotent } from './events.js'
import { NotFoundError } from './errors.js'
import { requireOrgEntity } from './scope.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString, optionalBoundedString } from './validate.js'
import type { HubMail } from './types.js'

export interface SendMailInput {
  orgId: string; boardId: string; fromAgent: string
  toAgent?: string | null; toHuman?: boolean
  subject?: string; body: string
  cardId?: string | null; kind?: string; replyTo?: string | null
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

/**
 * Same idempotent-replay treatment as the card ops (see `replayIfIdempotent` in
 * events.ts): a daemon's offline queue can resend a queued `mail.send` after
 * reconnect, and a replay must not deliver a second copy of the message.
 */
export async function sendMail(sql: HubSqlPool, input: SendMailInput): Promise<HubMail> {
  const body = boundedString(input.body, 'body', 100_000)
  const fromAgent = boundedString(input.fromAgent, 'from_agent', 120)
  const toAgent = optionalBoundedString(input.toAgent, 'to_agent', 120) ?? null
  const subject = optionalBoundedString(input.subject, 'subject', 200) ?? null
  const kind = optionalBoundedString(input.kind, 'kind', 40) ?? 'ask'

  return withTransaction(sql, async (tx) => {
    const replay = await replayIfIdempotent<HubMail>(tx, input.orgId, input.idempotencyKey, 'mail.sent')
    if (replay) return replay

    const board = await tx.query('SELECT id FROM boards WHERE org_id = $1 AND id = $2', [input.orgId, input.boardId])
    if (!board.rows[0]) throw new NotFoundError('board not found in this org')

    // `card_id` and `reply_to` are client-supplied foreign keys. Both are checked
    // against this org, in this transaction, so neither can write a reference to
    // another tenant's row or reveal whether one exists (see scope.ts).
    await requireOrgEntity(tx, input.orgId, 'card', input.cardId)
    await requireOrgEntity(tx, input.orgId, 'mail', input.replyTo)

    const inserted = await tx.query<HubMail>(
      `INSERT INTO mail (id, org_id, board_id, card_id, kind, subject, body, from_agent, to_agent, to_human, reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [`mail_${randomUUID()}`, input.orgId, input.boardId, input.cardId ?? null, kind, subject, body,
       fromAgent, toAgent, input.toHuman ?? false, input.replyTo ?? null],
    )
    const mail = inserted.rows[0]

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'mail.sent', boardId: input.boardId,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: mail,
    })
    return mail
  })
}

/**
 * Marks and returns this agent's undelivered mail in one statement, so two
 * concurrent drains by the same agent on two machines cannot both take a message.
 * Postgres's UPDATE has no ORDER BY, so `RETURNING` comes back in unspecified
 * order — sort by `created_at` here instead. The driver hands back `created_at`
 * as a native `Date` for a direct table row (as here) but as a JSON-parsed
 * string when read out of an event's stored payload elsewhere in this module,
 * so compare via `Date`, which accepts either, rather than `string.localeCompare`.
 */
export async function drainInbox(sql: HubSql, orgId: string, agentName: string): Promise<HubMail[]> {
  const result = await sql.query<HubMail>(
    `UPDATE mail SET delivered_at = now()
     WHERE org_id = $1 AND to_agent = $2 AND delivered_at IS NULL
     RETURNING *`,
    [orgId, agentName],
  )
  return [...result.rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
}
