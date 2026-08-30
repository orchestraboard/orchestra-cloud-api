import { randomUUID } from 'node:crypto'
import { appendOrgEvent, replayIfIdempotent } from './events.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString, emptyableBoundedString, optionalBoundedString, positiveInteger } from './validate.js'
import type { HubMilestone } from './types.js'

const MILESTONE_STATUSES = new Set(['open', 'shipped', 'dropped'])

export interface CreateMilestoneInput {
  orgId: string; boardId: string; title: string; description?: string
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export interface UpdateMilestoneInput {
  orgId: string; milestoneId: string; expectedVersion: number
  title?: string; description?: string; status?: string
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export interface DeleteMilestoneInput {
  orgId: string; milestoneId: string
  actorDeviceId?: string | null; idempotencyKey?: string | null
}

export async function listMilestones(sql: HubSql, orgId: string): Promise<HubMilestone[]> {
  const result = await sql.query<any>(
    'SELECT * FROM milestones WHERE org_id = $1 ORDER BY created_at', [orgId])
  return result.rows.map(rowToMilestone)
}

export async function createMilestone(sql: HubSqlPool, input: CreateMilestoneInput): Promise<HubMilestone> {
  const title = boundedString(input.title, 'title', 200)
  const description = emptyableBoundedString(input.description, 'description', 20_000) ?? ''

  return withTransaction(sql, async (tx) => {
    const replay = await replayIfIdempotent<HubMilestone>(tx, input.orgId, input.idempotencyKey, 'milestone.created')
    if (replay) return replay

    const board = await tx.query('SELECT id FROM boards WHERE org_id = $1 AND id = $2', [input.orgId, input.boardId])
    if (!board.rows[0]) throw new NotFoundError('board not found in this org')

    const inserted = await tx.query<any>(
      `INSERT INTO milestones (id, org_id, board_id, title, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [`milestone_${randomUUID()}`, input.orgId, input.boardId, title, description],
    )
    const milestone = rowToMilestone(inserted.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'milestone.created', boardId: input.boardId,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: milestone,
    })
    return milestone
  })
}

export async function updateMilestone(sql: HubSqlPool, input: UpdateMilestoneInput): Promise<HubMilestone> {
  const expectedVersion = positiveInteger(input.expectedVersion, 'expected_version')
  const title = optionalBoundedString(input.title, 'title', 200)
  const description = input.description === undefined ? undefined
    : emptyableBoundedString(input.description, 'description', 20_000) ?? ''
  if (input.status !== undefined && !MILESTONE_STATUSES.has(input.status)) {
    throw new ValidationError(`status must be one of ${[...MILESTONE_STATUSES].join(', ')}`)
  }

  return withTransaction(sql, async (tx) => {
    const replay = await replayIfIdempotent<HubMilestone>(tx, input.orgId, input.idempotencyKey, 'milestone.updated')
    if (replay) return replay

    const updated = await tx.query<any>(
      `UPDATE milestones SET
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         status = COALESCE($5, status),
         version = version + 1,
         updated_at = now()
       WHERE org_id = $1 AND id = $2 AND version = $6
       RETURNING *`,
      [input.orgId, input.milestoneId, title ?? null, description ?? null,
       input.status ?? null, expectedVersion],
    )
    if (!updated.rows[0]) {
      const current = await tx.query<any>(
        'SELECT * FROM milestones WHERE org_id = $1 AND id = $2', [input.orgId, input.milestoneId])
      if (!current.rows[0]) throw new NotFoundError('milestone not found in this org')
      throw new ConflictError(
        `milestone changed since version ${Number(current.rows[0].version) - 1}`,
        rowToMilestone(current.rows[0]))
    }
    const milestone = rowToMilestone(updated.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'milestone.updated', boardId: milestone.board_id,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey, payload: milestone,
    })
    return milestone
  })
}

export async function deleteMilestone(sql: HubSqlPool, input: DeleteMilestoneInput): Promise<{ id: string }> {
  return withTransaction(sql, async (tx) => {
    const replay = await replayIfIdempotent<{ id: string }>(tx, input.orgId, input.idempotencyKey, 'milestone.deleted')
    if (replay) return replay

    // The FK on cards is ON DELETE SET NULL, but the events must still say which
    // cards changed — readers project cards from events, not from table state.
    const deleted = await tx.query<any>(
      'DELETE FROM milestones WHERE org_id = $1 AND id = $2 RETURNING id, board_id',
      [input.orgId, input.milestoneId],
    )
    if (!deleted.rows[0]) throw new NotFoundError('milestone not found in this org')

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'milestone.deleted', boardId: deleted.rows[0].board_id,
      actorDeviceId: input.actorDeviceId, idempotencyKey: input.idempotencyKey,
      payload: { id: input.milestoneId, board_id: deleted.rows[0].board_id },
    })
    return { id: input.milestoneId }
  })
}

function rowToMilestone(row: any): HubMilestone {
  return {
    id: row.id, org_id: row.org_id, board_id: row.board_id,
    title: row.title, description: row.description, status: row.status,
    version: Number(row.version), created_at: row.created_at, updated_at: row.updated_at,
  }
}
