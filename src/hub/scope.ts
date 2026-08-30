import { ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import type { HubSql } from './sql.js'

/**
 * Every table an op can reference by id is org-scoped. Only these are addressable
 * from a request payload, and the table name is chosen here rather than passed
 * through, so a caller can never steer the lookup at an arbitrary relation.
 */
const SCOPED_TABLES = {
  card: 'cards',
  mail: 'mail',
  board: 'boards',
  agent: 'agents',
  milestone: 'milestones',
} as const

export type ScopedEntity = keyof typeof SCOPED_TABLES

/**
 * Asserts that `id` names a row of `entity` inside `orgId`, and returns whether an
 * id was supplied at all (null/undefined is "not referenced", not "not found").
 *
 * Foreign ids and ids that do not exist anywhere BOTH raise the same
 * `NotFoundError`, deliberately. Letting them differ is what turned an unchecked
 * insert into an existence oracle: a foreign `card_id` used to be written straight
 * through (200) while a nonexistent one tripped the foreign key (500), so anyone
 * with a token for any org could probe for the existence of any id on the hub. A
 * caller may not learn anything about rows outside its own org — including whether
 * they exist.
 *
 * Call inside the op's transaction, so the row cannot be deleted between the check
 * and the insert that depends on it.
 */
export async function requireOrgEntity(
  tx: HubSql, orgId: string, entity: ScopedEntity, id: unknown,
): Promise<boolean> {
  if (id === undefined || id === null) return false
  if (typeof id !== 'string') throw new NotFoundError(`${entity} not found in this org`)

  const result = await tx.query(
    `SELECT 1 FROM ${SCOPED_TABLES[entity]} WHERE org_id = $1 AND id = $2`, [orgId, id],
  )
  if (!result.rows[0]) throw new NotFoundError(`${entity} not found in this org`)
  return true
}

/**
 * The single org-scope gate. Every org-scoped route resolves its org through this, so a
 * principal that has no org scope is refused in one place rather than in each route — and a
 * route added later is closed by default.
 *
 * A CLI token (`orchestra login`) authenticates fine and deliberately carries no org scope:
 * it exists to list your orgs and connect a daemon, never to read or write an organization's
 * work. That is a denial, not a malformed request, so it answers 403 rather than 400.
 */
export function requireOrgScope(request: {
  hubOrgId: string | null
  hubCliUserId?: string | null
}): string {
  if (request.hubOrgId) return request.hubOrgId
  if (request.hubCliUserId) {
    throw new ForbiddenError('a CLI token cannot read or write organization data; it only connects a daemon')
  }
  throw new ValidationError('org scope was not resolved')
}
