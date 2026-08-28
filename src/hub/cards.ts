import { randomUUID } from 'node:crypto'
import { appendOrgEvent, findOrgEventByIdempotencyKey } from './events.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString, optionalBoundedString, positiveInteger, stringList } from './validate.js'
import type { HubCard } from './types.js'

const CARD_COLUMNS = new Set(['backlog', 'todo', 'in_progress', 'review', 'done'])

export interface CreateCardInput {
  orgId: string; boardId: string; title: string; description?: string
  paths?: string[]; ownerAgent?: string | null
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export interface UpdateCardInput {
  orgId: string; cardId: string; expectedVersion: number
  title?: string; description?: string; paths?: string[]
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export interface MoveCardInput {
  orgId: string; cardId: string; expectedVersion: number; column: string
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export interface ClaimCardInput {
  orgId: string; cardId: string; agent: string
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export async function getCard(sql: HubSql, orgId: string, cardId: string): Promise<HubCard | null> {
  const result = await sql.query<any>('SELECT * FROM cards WHERE org_id = $1 AND id = $2', [orgId, cardId])
  return result.rows[0] ? rowToCard(result.rows[0]) : null
}

export async function createCard(sql: HubSqlPool, input: CreateCardInput): Promise<HubCard> {
  const title = boundedString(input.title, 'title', 200)
  const description = optionalBoundedString(input.description, 'description', 20_000) ?? ''
  const paths = stringList(input.paths, 'paths', 50, 400)

  return withTransaction(sql, async (tx) => {
    const replay = await replayIfIdempotent(tx, input.orgId, input.idempotencyKey)
    if (replay) return replay

    const board = await tx.query('SELECT id FROM boards WHERE org_id = $1 AND id = $2', [input.orgId, input.boardId])
    if (!board.rows[0]) throw new NotFoundError('board not found in this org')

    const inserted = await tx.query<any>(
      `INSERT INTO cards (id, org_id, board_id, number, title, description, owner_agent, paths)
       VALUES ($1, $2, $3,
               (SELECT COALESCE(MAX(number), 0) + 1 FROM cards WHERE board_id = $3),
               $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [`card_${randomUUID()}`, input.orgId, input.boardId, title, description,
       input.ownerAgent ?? null, JSON.stringify(paths)],
    )
    const card = rowToCard(inserted.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'card.created', boardId: input.boardId,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: card,
    })
    return card
  })
}

export async function updateCard(sql: HubSqlPool, input: UpdateCardInput): Promise<HubCard> {
  const expectedVersion = positiveInteger(input.expectedVersion, 'expected_version')
  const title = optionalBoundedString(input.title, 'title', 200)
  const description = input.description === undefined ? undefined
    : optionalBoundedString(input.description, 'description', 20_000) ?? ''
  const paths = input.paths === undefined ? undefined : stringList(input.paths, 'paths', 50, 400)

  return withTransaction(sql, async (tx) => {
    const replay = await replayIfIdempotent(tx, input.orgId, input.idempotencyKey)
    if (replay) return replay

    const updated = await tx.query<any>(
      `UPDATE cards SET
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         paths = COALESCE($5::jsonb, paths),
         version = version + 1,
         updated_at = now()
       WHERE org_id = $1 AND id = $2 AND version = $6
       RETURNING *`,
      [input.orgId, input.cardId, title ?? null, description ?? null,
       paths === undefined ? null : JSON.stringify(paths), expectedVersion],
    )
    if (!updated.rows[0]) await failStaleOrMissing(tx, input.orgId, input.cardId)
    const card = rowToCard(updated.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'card.updated', boardId: card.board_id,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: card,
    })
    return card
  })
}

export async function moveCard(sql: HubSqlPool, input: MoveCardInput): Promise<HubCard> {
  const expectedVersion = positiveInteger(input.expectedVersion, 'expected_version')
  const column = boundedString(input.column, 'column', 40)
  if (!CARD_COLUMNS.has(column)) {
    throw new ValidationError(`column must be one of ${[...CARD_COLUMNS].join(', ')}`)
  }

  return withTransaction(sql, async (tx) => {
    const replay = await replayIfIdempotent(tx, input.orgId, input.idempotencyKey)
    if (replay) return replay

    const updated = await tx.query<any>(
      `UPDATE cards SET column_name = $3, version = version + 1, updated_at = now()
       WHERE org_id = $1 AND id = $2 AND version = $4
       RETURNING *`,
      [input.orgId, input.cardId, column, expectedVersion],
    )
    if (!updated.rows[0]) await failStaleOrMissing(tx, input.orgId, input.cardId)
    const card = rowToCard(updated.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'card.moved', boardId: card.board_id,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: card,
    })
    return card
  })
}

/**
 * First writer wins. The `owner_agent IS NULL OR owner_agent = $3` predicate is the
 * whole mutual-exclusion mechanism: two daemons racing for the same card issue the
 * same UPDATE, Postgres serialises them, and the second one matches zero rows.
 */
export async function claimCard(sql: HubSqlPool, input: ClaimCardInput): Promise<HubCard> {
  const agent = boundedString(input.agent, 'agent', 120)

  return withTransaction(sql, async (tx) => {
    const replay = await replayIfIdempotent(tx, input.orgId, input.idempotencyKey)
    if (replay) return replay

    const claimed = await tx.query<any>(
      `UPDATE cards SET owner_agent = $3, version = version + 1, updated_at = now()
       WHERE org_id = $1 AND id = $2 AND (owner_agent IS NULL OR owner_agent = $3)
       RETURNING *`,
      [input.orgId, input.cardId, agent],
    )
    if (!claimed.rows[0]) {
      const current = await getCard(tx, input.orgId, input.cardId)
      if (!current) throw new NotFoundError('card not found in this org')
      throw new ConflictError(`card is already claimed by ${current.owner_agent}`, current)
    }
    const card = rowToCard(claimed.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'card.claimed', boardId: card.board_id,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: card,
    })
    return card
  })
}

/**
 * Idempotent-retry short-circuit: called at the top of every mutating op, before
 * anything touches the `cards` table. When `idempotencyKey` names an event this org
 * already recorded, the retried op is presumed to be a replay of that same call — the
 * daemon's offline queue resends ops after a reconnect, and the caller may not know
 * whether its first attempt actually committed. We return the entity exactly as the
 * original call left it (the event's stored payload) and perform no mutation at all,
 * so a replay never double-applies, never bumps `version` twice, and never appends a
 * second event. `appendOrgEvent`'s own "same key, different payload" ConflictError
 * stays in place as a backstop for the race window where two concurrent calls with
 * the same key both pass this check before either has committed its event.
 */
async function replayIfIdempotent(
  tx: HubSql, orgId: string, idempotencyKey: string | null | undefined,
): Promise<HubCard | null> {
  if (!idempotencyKey) return null
  const prior = await findOrgEventByIdempotencyKey(tx, orgId, idempotencyKey)
  return prior ? (prior.payload as HubCard) : null
}

/** Zero rows updated means either the card is gone or someone else moved first. */
async function failStaleOrMissing(tx: HubSql, orgId: string, cardId: string): Promise<never> {
  const current = await getCard(tx, orgId, cardId)
  if (!current) throw new NotFoundError('card not found in this org')
  throw new ConflictError(`card changed since version ${current.version - 1}`, current)
}

function rowToCard(row: any): HubCard {
  return {
    id: row.id, org_id: row.org_id, board_id: row.board_id, number: Number(row.number),
    title: row.title, description: row.description, column: row.column_name,
    owner_agent: row.owner_agent, paths: Array.isArray(row.paths) ? row.paths : JSON.parse(row.paths ?? '[]'),
    version: Number(row.version), created_at: row.created_at, updated_at: row.updated_at,
  }
}
