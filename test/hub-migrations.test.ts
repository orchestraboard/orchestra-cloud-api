import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { hubMigrate } from '../src/hub/migrations.js'
import type { HubSql } from '../src/hub/sql.js'

function pglite(): HubSql {
  const db = new PGlite()
  return { query: async (text, params) => {
    const r = await db.query(text, params ? [...params] : undefined)
    return { rows: (r.rows ?? []) as any[], rowCount: r.rows?.length ?? 0 }
  } }
}

describe('hub migrations', () => {
  it('creates core tables and is idempotent', async () => {
    const sql = pglite()

    const first = await hubMigrate(sql)
    expect(first).toContain('001-hub-core')

    const tables = await sql.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    )
    const names = tables.rows.map((r) => r.table_name)
    expect(names).toEqual(expect.arrayContaining([
      'hub_schema_migrations', 'orgs', 'users', 'memberships', 'subscriptions', 'devices', 'projects', 'boards',
    ]))

    const second = await hubMigrate(sql)
    expect(second).toEqual([])
  })

  it('rejects a second org with the same slug', async () => {
    const sql = pglite()
    await hubMigrate(sql)
    await sql.query("INSERT INTO orgs (id, name, slug) VALUES ('org_a', 'A', 'acme')")
    await expect(
      sql.query("INSERT INTO orgs (id, name, slug) VALUES ('org_b', 'B', 'acme')"),
    ).rejects.toThrow()
  })
})
