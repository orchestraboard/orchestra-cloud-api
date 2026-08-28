import { randomUUID } from 'node:crypto'
import { appendOrgEvent } from './events.js'
import { NotFoundError, ValidationError } from './errors.js'
import { requireOrgEntity } from './scope.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString, optionalBoundedString } from './validate.js'
import type { HubAgent, HubAgentState } from './types.js'

const DEFAULT_TTL_SECONDS = 45

/**
 * The `HubAgentState` union, at runtime. Mirrors the CHECK constraint on
 * `agents.state` in migration 002 — a value that passes here must pass there, or a
 * client's bad input surfaces as a 500 from the database instead of a 400 from us.
 */
const AGENT_STATES = new Set<string>(['working', 'idle', 'waiting', 'offline'])

export function agentState(value: unknown): HubAgentState {
  if (typeof value !== 'string' || !AGENT_STATES.has(value)) {
    throw new ValidationError(`state must be one of ${[...AGENT_STATES].join(', ')}`)
  }
  return value as HubAgentState
}

export interface RegisterAgentInput {
  orgId: string; boardId: string; name: string; deviceId?: string | null
}

export interface HeartbeatInput {
  orgId: string; agentId: string; state: HubAgentState
  currentCardId?: string | null; activity?: string | null
}

export async function registerAgent(sql: HubSqlPool, input: RegisterAgentInput): Promise<HubAgent> {
  const name = boundedString(input.name, 'name', 120)

  return withTransaction(sql, async (tx) => {
    const board = await tx.query('SELECT id FROM boards WHERE org_id = $1 AND id = $2', [input.orgId, input.boardId])
    if (!board.rows[0]) throw new NotFoundError('board not found in this org')

    const existing = await tx.query<HubAgent>(
      'SELECT * FROM agents WHERE org_id = $1 AND board_id = $2 AND name = $3',
      [input.orgId, input.boardId, name],
    )
    if (existing.rows[0]) return normalize(existing.rows[0])

    const inserted = await tx.query<HubAgent>(
      `INSERT INTO agents (id, org_id, board_id, device_id, name)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [`agent_${randomUUID()}`, input.orgId, input.boardId, input.deviceId ?? null, name],
    )
    const agent = normalize(inserted.rows[0])

    await appendOrgEvent(tx, {
      orgId: input.orgId, kind: 'agent.registered', boardId: input.boardId,
      actorDeviceId: input.deviceId ?? null, payload: agent,
    })
    return agent
  })
}

/**
 * Presence is latest-state-only and deliberately does NOT append to `org_events`:
 * a heartbeat every 15s per agent would swamp the replayable log for no benefit.
 * Live viewers get presence from the SSE presence frame instead.
 */
export async function heartbeat(sql: HubSqlPool, input: HeartbeatInput): Promise<HubAgent> {
  const activity = optionalBoundedString(input.activity, 'activity', 200) ?? null
  const state = agentState(input.state)

  // `current_card_id` is a client-supplied foreign key. It is checked against this
  // org, in the same transaction as the UPDATE, so a card from another tenant is a
  // 404 rather than a silently written cross-tenant reference (see scope.ts).
  return withTransaction(sql, async (tx) => {
    await requireOrgEntity(tx, input.orgId, 'card', input.currentCardId)

    const result = await tx.query<HubAgent>(
      `UPDATE agents SET state = $3, current_card_id = $4, activity = $5, last_heartbeat_at = now()
       WHERE org_id = $1 AND id = $2 RETURNING *`,
      [input.orgId, input.agentId, state, input.currentCardId ?? null, activity],
    )
    if (!result.rows[0]) throw new NotFoundError('agent not found in this org')
    return normalize(result.rows[0])
  })
}

/**
 * Flips agents whose heartbeat has lapsed to `offline`. Returns how many changed.
 *
 * Uses `make_interval(secs => $2::int)` rather than `($2 || ' seconds')::interval`
 * (string-concatenation into an interval literal): the latter requires Postgres to
 * infer that a numeric bind parameter should first coerce to text, which it is not
 * guaranteed to do for a bare parameter feeding a `||` operator, and PGlite's parser
 * rejects it outright. `make_interval` takes the count as a normal typed argument, so
 * an explicit `::int` cast on the parameter is all that's needed — no operand-type
 * inference. Verified against PGlite in the TTL test.
 */
export async function sweepStalePresence(
  sql: HubSql, orgId: string, ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<number> {
  const result = await sql.query(
    `UPDATE agents SET state = 'offline'
     WHERE org_id = $1 AND state <> 'offline'
       AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - make_interval(secs => $2::int))
     RETURNING id`,
    [orgId, ttlSeconds],
  )
  return result.rows.length
}

export async function listAgents(sql: HubSql, orgId: string, boardId?: string): Promise<HubAgent[]> {
  const result = boardId
    ? await sql.query<HubAgent>('SELECT * FROM agents WHERE org_id = $1 AND board_id = $2 ORDER BY name', [orgId, boardId])
    : await sql.query<HubAgent>('SELECT * FROM agents WHERE org_id = $1 ORDER BY name', [orgId])
  return result.rows.map(normalize)
}

function normalize(row: any): HubAgent {
  return {
    id: row.id, org_id: row.org_id, board_id: row.board_id, device_id: row.device_id,
    name: row.name, state: row.state, current_card_id: row.current_card_id,
    activity: row.activity, last_heartbeat_at: row.last_heartbeat_at,
  }
}
