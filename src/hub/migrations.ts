import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { HubSql } from './sql.js'

/**
 * Numbered, append-only, and never edited after shipping — the same contract the
 * local runner (`applyAgentOsMigrations`) holds for SQLite.
 */
export const HUB_MIGRATIONS: readonly { id: string; sqlFile: string }[] = [
  { id: '001-hub-core', sqlFile: '001-hub-core.sql' },
  { id: '002-hub-work', sqlFile: '002-hub-work.sql' },
  { id: '003-hub-events', sqlFile: '003-hub-events.sql' },
]

async function migrationSql(sqlFile: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./migrations/${sqlFile}`, import.meta.url)), 'utf8')
}

/**
 * Splits a migration file into individual statements. `HubSql.query` runs one
 * statement per call — real `pg` tolerates a multi-statement string, but PGlite's
 * extended-query protocol (what the test adapter uses) rejects it, so the runner
 * must send statements one at a time to work against both. Line comments are
 * stripped first so a `;` inside a `--` comment doesn't split the statement.
 */
function splitStatements(sqlFile: string): string[] {
  const withoutLineComments = sqlFile
    .split('\n')
    .map((line) => {
      const commentIndex = line.indexOf('--')
      return commentIndex === -1 ? line : line.slice(0, commentIndex)
    })
    .join('\n')
  return withoutLineComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/** Applies every unapplied migration in order. Returns the ids applied this run. */
export async function hubMigrate(sql: HubSql): Promise<string[]> {
  await sql.query(`CREATE TABLE IF NOT EXISTS hub_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)

  const applied = await sql.query<{ id: string }>('SELECT id FROM hub_schema_migrations')
  const done = new Set(applied.rows.map((row) => row.id))
  const ran: string[] = []

  for (const migration of HUB_MIGRATIONS) {
    if (done.has(migration.id)) continue
    const fileSql = await migrationSql(migration.sqlFile)
    for (const statement of splitStatements(fileSql)) {
      await sql.query(statement)
    }
    await sql.query('INSERT INTO hub_schema_migrations (id) VALUES ($1)', [migration.id])
    ran.push(migration.id)
  }
  return ran
}
