import { NotFoundError } from './errors.js'
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
