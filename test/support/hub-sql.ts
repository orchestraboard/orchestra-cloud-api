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

/** `clerkOrgId` is optional and only needed by tests that authenticate as a Clerk principal. */
export async function seedOrg(sql: HubSql, orgId: string, clerkOrgId?: string): Promise<void> {
  await sql.query('INSERT INTO orgs (id, name, slug, clerk_org_id) VALUES ($1, $2, $3, $4)', [
    orgId, orgId, orgId, clerkOrgId ?? null,
  ])
}

export async function seedBoard(sql: HubSql, orgId: string, boardId: string): Promise<void> {
  await sql.query('INSERT INTO projects (id, org_id, name) VALUES ($1, $2, $3)', [`proj_${boardId}`, orgId, boardId])
  await sql.query('INSERT INTO boards (id, org_id, project_id, name) VALUES ($1, $2, $3, $4)', [
    boardId, orgId, `proj_${boardId}`, boardId,
  ])
}

/** Mirrors a Clerk user directly with SQL — Task 4 (not built yet) is what will populate this from webhooks. */
export async function seedUser(sql: HubSql, userId: string, clerkUserId: string, email = `${userId}@example.com`): Promise<void> {
  await sql.query('INSERT INTO users (id, clerk_user_id, email) VALUES ($1, $2, $3)', [userId, clerkUserId, email])
}

/** Mirrors a Clerk org membership directly with SQL, for the same reason as `seedUser`. */
export async function seedMembership(sql: HubSql, membershipId: string, orgId: string, userId: string): Promise<void> {
  await sql.query('INSERT INTO memberships (id, org_id, user_id) VALUES ($1, $2, $3)', [membershipId, orgId, userId])
}
