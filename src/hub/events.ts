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
 *
 * Contract: the counter bump and the `org_events` insert are two statements,
 * not one. Callers that also mutate an entity (a card, mail, an agent row)
 * MUST invoke this inside the same `withTransaction` as that mutation, so the
 * entity write and the event append commit or roll back together — pass the
 * transaction handle as `tx`. A bare call (no surrounding transaction) is only
 * for tests and for appends with no accompanying entity mutation.
 *
 * The idempotency replay check runs first and short-circuits before any
 * allocation, so a replayed key never burns a seq number. Allocation itself is
 * a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, which takes a row
 * lock on the counter row and so serialises correctly against concurrent
 * callers.
 *
 * Accepted residual risk: if the process dies between the counter bump and
 * the `org_events` insert (or a bare, non-transactional call fails between
 * them), that seq number is burned — it is never reused, and later events
 * keep allocating from the counter's new value. This is benign by design: it
 * produces a gap, never a duplicate, never a lost event, and never a bad
 * resume, because `readOrgEventsSince` reads `seq > since` ordered ascending
 * and a number with no row is simply skipped. Do NOT "fix" gaplessness by
 * reusing a burned number — that would let a replayed/retried append collide
 * with an unrelated already-delivered event at the same seq, which WOULD
 * break resume.
 *
 * Concurrent-replay race: two callers with the same idempotency key can both
 * pass the pre-check above before either has committed, and both attempt the
 * INSERT. `org_events_idempotency_idx` (a UNIQUE index on (org_id,
 * idempotency_key), migration 003) then rejects the loser with Postgres
 * SQLSTATE 23505. Rather than let that surface as a raw DB error, the loser
 * re-reads the row the winner just committed and returns it — the winner
 * already appended exactly the event this caller wanted, so returning it IS
 * the correct idempotent answer, not an error. Only a kind mismatch (or,
 * defensively, no row found at all) still throws.
 */
export async function appendOrgEvent(tx: HubSql, input: AppendOrgEvent): Promise<HubEvent> {
  const key = input.idempotencyKey ?? null
  if (key) {
    const existing = await tx.query<HubEvent>(
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

  const allocated = await tx.query<{ next_seq: string | number }>(
    `INSERT INTO org_event_seq (org_id, next_seq) VALUES ($1, 1)
     ON CONFLICT (org_id) DO UPDATE SET next_seq = org_event_seq.next_seq + 1
     RETURNING next_seq`,
    [input.orgId],
  )
  const seq = Number(allocated.rows[0]?.next_seq)

  try {
    const inserted = await tx.query<HubEvent>(
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
  } catch (error) {
    if (!key || !isIdempotencyUniqueViolation(error)) throw error
    const winner = await tx.query<HubEvent>(
      'SELECT * FROM org_events WHERE org_id = $1 AND idempotency_key = $2',
      [input.orgId, key],
    )
    const prior = winner.rows[0]
    if (!prior) throw error
    if (prior.kind !== input.kind) {
      throw new ConflictError('idempotency key was already used for a different event')
    }
    return normalize(prior)
  }
}

/**
 * Detects a unique-violation on `org_events_idempotency_idx` defensively: real
 * Postgres and PGlite both surface SQLSTATE `23505` as `error.code` (verified against
 * PGlite directly — same wire-protocol error fields node-postgres exposes), so that is
 * the primary check. The constraint-name / message match is a fallback in case either
 * driver ever shapes the error differently for this index specifically.
 */
function isIdempotencyUniqueViolation(error: unknown): boolean {
  const err = error as { code?: string; constraint?: string; message?: string } | undefined
  if (!err) return false
  // `org_events` has one other unique constraint, UNIQUE(org_id, seq) — also SQLSTATE
  // 23505 but a different bug entirely (the seq counter, not idempotency). When the
  // driver gives us a constraint name, require it name this index specifically so we
  // never mistake that unrelated violation for a replay race.
  if (err.constraint) return err.constraint.includes('idempotency')
  if (err.code !== '23505') return false
  return `${err.message ?? ''}`.toLowerCase().includes('org_events_idempotency_idx')
}

/**
 * Looks up a prior event by idempotency key, for callers that need to short-circuit
 * a retried mutation BEFORE touching the entity (see cards.ts). Returns null when the
 * key has never been used in this org.
 */
export async function findOrgEventByIdempotencyKey(
  tx: HubSql, orgId: string, key: string,
): Promise<HubEvent | null> {
  const result = await tx.query<HubEvent>(
    'SELECT * FROM org_events WHERE org_id = $1 AND idempotency_key = $2',
    [orgId, key],
  )
  return result.rows[0] ? normalize(result.rows[0]) : null
}

/**
 * Idempotent-retry short-circuit: call at the top of every mutating op, before
 * anything touches the entity's own table. When `idempotencyKey` names an event
 * this org already recorded, the retried op is presumed to be a replay of that
 * same call — a daemon's offline queue resends ops after a reconnect, and the
 * caller may not know whether its first attempt actually committed. Return the
 * entity exactly as the original call left it (the event's stored payload) and
 * perform no mutation at all, so a replay never double-applies and never
 * appends a second event.
 *
 * A prior event under the same key but a DIFFERENT kind is not a replay — it's
 * a key collision (e.g. a client bug that reuses one key across a `createCard`
 * and a later `sendMail`). That must fail loudly rather than silently hand
 * back the wrong op's result, so it throws `ConflictError` instead of
 * returning. `appendOrgEvent`'s own "same key, different payload/kind" check
 * stays in place as a backstop for the race window where two concurrent calls
 * with the same key both pass this check before either has committed its
 * event.
 *
 * Shared by every mutating op across `cards.ts` and `mail.ts` — keep it here
 * rather than forking a per-module copy.
 */
export async function replayIfIdempotent<T>(
  tx: HubSql, orgId: string, idempotencyKey: string | null | undefined, expectedKind: HubEventKind,
): Promise<T | null> {
  if (!idempotencyKey) return null
  const prior = await findOrgEventByIdempotencyKey(tx, orgId, idempotencyKey)
  if (!prior) return null
  if (prior.kind !== expectedKind) {
    throw new ConflictError('idempotency key was already used for a different operation')
  }
  return prior.payload as T
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
