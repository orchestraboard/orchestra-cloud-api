import { PGlite } from '@electric-sql/pglite'
import { hubMigrate } from '../../src/hub/migrations.js'
import type { HubSql } from '../../src/hub/sql.js'

/** A migrated, in-process Postgres. No Docker, no live DB, one per test. */
export async function hubTestSql(): Promise<HubSql> {
  const db = new PGlite()
  const sql: HubSql = {
    query: async (text, params) => {
      const result = await db.query(text, params ? [...params] : undefined)
      const rows = (result.rows ?? []) as any[]
      return { rows, rowCount: rows.length }
    },
  }
  await hubMigrate(sql)
  return sql
}

export async function seedOrg(sql: HubSql, orgId: string): Promise<void> {
  await sql.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [orgId, orgId, orgId])
}

export async function seedBoard(sql: HubSql, orgId: string, boardId: string): Promise<void> {
  await sql.query('INSERT INTO projects (id, org_id, name) VALUES ($1, $2, $3)', [`proj_${boardId}`, orgId, boardId])
  await sql.query('INSERT INTO boards (id, org_id, project_id, name) VALUES ($1, $2, $3, $4)', [
    boardId, orgId, `proj_${boardId}`, boardId,
  ])
}
