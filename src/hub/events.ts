import { randomUUID } from 'node:crypto'
import { ConflictError } from './errors.js'
import type { HubSql } from './sql.js'
import type { HubEvent, HubEventKind } from './types.js'

export interface AppendOrgEvent {
  orgId: string
  kind: HubEventKind
  boardId?: string | null
  actorDeviceId?: string | null
  idempotencyKey?: string | null
  payload: unknown
}

/**
 * Appends one event and allocates the org's next `seq` from `org_event_seq`.
 * The idempotency replay check runs first and short-circuits before any
 * allocation, so a replayed key never burns a seq number. Allocation itself is
 * a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, which takes a row
 * lock on the counter row and so serialises correctly against concurrent
 * callers — whether `appendOrgEvent` is called bare or inside `withTransaction`.
 * Callers that also mutate an entity MUST wrap both in one `withTransaction`.
 */
export async function appendOrgEvent(sql: HubSql, input: AppendOrgEvent): Promise<HubEvent> {
  const key = input.idempotencyKey ?? null
  if (key) {
    const existing = await sql.query<HubEvent>(
      'SELECT * FROM org_events WHERE org_id = $1 AND idempotency_key = $2',
      [input.orgId, key],
    )
    const prior = existing.rows[0]
    if (prior) {
      const samePayload = JSON.stringify(prior.payload) === JSON.stringify(input.payload ?? {})
      if (prior.kind === input.kind && samePayload) return normalize(prior)
      throw new ConflictError('idempotency key was already used for a different event')
    }
  }

  const allocated = await sql.query<{ next_seq: string | number }>(
    `INSERT INTO org_event_seq (org_id, next_seq) VALUES ($1, 1)
     ON CONFLICT (org_id) DO UPDATE SET next_seq = org_event_seq.next_seq + 1
     RETURNING next_seq`,
    [input.orgId],
  )
  const seq = Number(allocated.rows[0]?.next_seq)

  const inserted = await sql.query<HubEvent>(
    `INSERT INTO org_events (id, org_id, seq, kind, board_id, actor_device_id, idempotency_key, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      `evt_${randomUUID()}`, input.orgId, seq, input.kind,
      input.boardId ?? null, input.actorDeviceId ?? null, key,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  return normalize(inserted.rows[0])
}

/** Events strictly after `since`, oldest first — the daemon's resume read. */
export async function readOrgEventsSince(
  sql: HubSql, orgId: string, since: number, limit = 500,
): Promise<HubEvent[]> {
  const result = await sql.query<HubEvent>(
    'SELECT * FROM org_events WHERE org_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3',
    [orgId, since, limit],
  )
  return result.rows.map(normalize)
}

export async function latestOrgSeq(sql: HubSql, orgId: string): Promise<number> {
  const result = await sql.query<{ seq: string | number | null }>(
    'SELECT MAX(seq) AS seq FROM org_events WHERE org_id = $1', [orgId],
  )
  return Number(result.rows[0]?.seq ?? 0)
}

/** Postgres returns BIGINT as a string through node-postgres; the wire type is a number. */
function normalize(row: HubEvent): HubEvent {
  return { ...row, seq: Number(row.seq) }
}
