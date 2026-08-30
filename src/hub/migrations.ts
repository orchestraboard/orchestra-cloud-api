import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { HubSql, HubSqlPool } from './sql.js'

/**
 * Numbered, append-only, and never edited after shipping — the same contract the
 * local runner (`applyAgentOsMigrations`) holds for SQLite.
 */
export const HUB_MIGRATIONS: readonly { id: string; sqlFile: string }[] = [
  { id: '001-hub-core', sqlFile: '001-hub-core.sql' },
  { id: '002-hub-work', sqlFile: '002-hub-work.sql' },
  { id: '003-hub-events', sqlFile: '003-hub-events.sql' },
  { id: '004-hub-event-seq', sqlFile: '004-hub-event-seq.sql' },
  { id: '005-hub-entitlements', sqlFile: '005-hub-entitlements.sql' },
  { id: '006-cli-auth', sqlFile: '006-cli-auth.sql' },
]

/**
 * Resolves the `.sql` files that sit NEXT TO this module, wherever it ended up.
 *
 * From source (tsx) that is `src/hub/migrations/`. From the build it is
 * `dist/migrations/`, NOT `dist/hub/migrations/`: tsup has a single entry
 * (`src/cli.ts`) with ESM code splitting, so this module — reached only through
 * a dynamic import in hub-cli.ts — is emitted as a flat chunk at the dist root
 * (`dist/migrations-<hash>.js`) and `./migrations/` resolves relative to that.
 * `scripts/copy-hub-migrations.mjs` puts the SQL where this resolves to; the
 * two must move together, which `test/hub-build-migrations.test.ts` enforces
 * against a real build.
 */
async function migrationSql(sqlFile: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./migrations/${sqlFile}`, import.meta.url)), 'utf8')
}

/**
 * A fixed key for `pg_advisory_lock`, so concurrent `orchestra hub` boots serialise
 * their migration runs instead of racing to the same `hub_schema_migrations` insert
 * (the loser of that race dies on the primary key). Arbitrary but permanent — changing
 * it would let an old and a new build migrate at the same time.
 */
const MIGRATION_LOCK_KEY = 6_812_913_540_128_745

/**
 * Splits a migration file into individual statements. `HubSql.query` runs one
 * statement per call — real `pg` tolerates a multi-statement string, but PGlite's
 * extended-query protocol (what the test adapter uses) rejects it, so the runner
 * must send statements one at a time to work against both.
 *
 * This is a scanner rather than `split(';')` because a `;` or a `--` is only a
 * separator or a comment when it is not inside something else. It tracks
 * single-quoted literals (with the `''` escape, and backslash escapes inside an
 * `E'...'` literal), double-quoted identifiers, `--` line comments, `/* *\/` block
 * comments (which nest in Postgres), and `$tag$ ... $tag$` dollar-quoted bodies —
 * so a future migration carrying a `CREATE FUNCTION ... $$ ... $$` body, or a
 * semicolon or `--` inside a string, survives intact instead of being cut in half.
 *
 * Anything it cannot account for — an unterminated literal, comment, or
 * dollar-quote — throws. Refusing to run a migration is the correct failure here;
 * silently applying half of one is not.
 */
export function splitStatements(fileSql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0

  while (i < fileSql.length) {
    const ch = fileSql[i]
    const next = fileSql[i + 1]

    if (ch === '-' && next === '-') {
      const lineEnd = fileSql.indexOf('\n', i)
      i = lineEnd === -1 ? fileSql.length : lineEnd
      continue
    }

    if (ch === '/' && next === '*') {
      i = skipBlockComment(fileSql, i)
      current += ' '
      continue
    }

    if (ch === "'" || ch === '"') {
      const end = scanQuoted(fileSql, i, ch, ch === "'" && endsWithEscapePrefix(current))
      current += fileSql.slice(i, end)
      i = end
      continue
    }

    const tag = dollarQuoteTagAt(fileSql, i)
    if (tag) {
      const close = fileSql.indexOf(tag, i + tag.length)
      if (close === -1) throw new Error(`unterminated dollar-quoted string (${tag}) in migration SQL`)
      const end = close + tag.length
      current += fileSql.slice(i, end)
      i = end
      continue
    }

    if (ch === ';') {
      statements.push(current)
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }

  statements.push(current)
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0)
}

/** Returns the index just past the closing `*\/`. Block comments nest in Postgres. */
function skipBlockComment(sql: string, start: number): number {
  let depth = 1
  let i = start + 2
  while (i < sql.length && depth > 0) {
    if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 }
    else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
    else i++
  }
  if (depth > 0) throw new Error('unterminated block comment in migration SQL')
  return i
}

/** Returns the index just past the closing quote. */
function scanQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1
  for (;;) {
    if (i >= sql.length) {
      const what = quote === "'" ? 'string literal' : 'quoted identifier'
      throw new Error(`unterminated ${what} in migration SQL`)
    }
    if (backslashEscapes && sql[i] === '\\') { i += 2; continue }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) { i += 2; continue }
      return i + 1
    }
    i++
  }
}

/** True when the literal about to be scanned is an `E'...'` escape-string literal. */
function endsWithEscapePrefix(current: string): boolean {
  return /(^|[^A-Za-z0-9_$])[Ee]$/.test(current)
}

/**
 * `$$` or `$tag$` at `index`, or null. A tag may not start with a digit, so a `$1`
 * bind parameter (or `$1$`) is never mistaken for the opening of a quoted body.
 */
function dollarQuoteTagAt(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null
  let end = index + 1
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end++
  if (sql[end] !== '$') return null
  const tag = sql.slice(index, end + 1)
  if (tag.length > 2 && /[0-9]/.test(tag[1])) return null
  return tag
}

/**
 * Applies every unapplied migration in order. Returns the ids applied this run.
 *
 * Two properties this must hold, both learned the hard way:
 *
 * 1. Each migration's statements and its `hub_schema_migrations` row commit
 *    together. Postgres has transactional DDL, so a migration that fails halfway
 *    rolls all the way back and the next boot retries it from a clean schema.
 *    Without this a failure leaves the schema half-applied with nothing recorded,
 *    which only 001-004 survive because every statement in them is `IF NOT EXISTS`.
 * 2. Concurrent runs serialise. `orchestra hub` migrates on every boot, so two
 *    instances starting together would otherwise both reach the insert.
 *
 * Both need the same connection for the whole run: `pg_advisory_lock` is
 * session-scoped, and BEGIN/COMMIT issued through a pool would land on whichever
 * connection the pool happened to hand out. So this checks out one connection and
 * drives the transactions on it directly rather than going through
 * `withTransaction`, which would check out its own.
 */
export async function hubMigrate(sql: HubSqlPool): Promise<string[]> {
  const conn = sql.connect ? await sql.connect() : null
  const handle: HubSql = conn ?? sql
  try {
    await handle.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY])
    try {
      return await applyMigrations(handle)
    } finally {
      await handle.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]).catch(() => {})
    }
  } finally {
    conn?.release()
  }
}

async function applyMigrations(handle: HubSql): Promise<string[]> {
  await handle.query(`CREATE TABLE IF NOT EXISTS hub_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)

  const applied = await handle.query<{ id: string }>('SELECT id FROM hub_schema_migrations')
  const done = new Set(applied.rows.map((row) => row.id))
  const ran: string[] = []

  for (const migration of HUB_MIGRATIONS) {
    if (done.has(migration.id)) continue
    const statements = splitStatements(await migrationSql(migration.sqlFile))

    await handle.query('BEGIN')
    try {
      for (const statement of statements) await handle.query(statement)
      await handle.query('INSERT INTO hub_schema_migrations (id) VALUES ($1)', [migration.id])
      await handle.query('COMMIT')
    } catch (error) {
      await handle.query('ROLLBACK').catch(() => {})
      throw error
    }
    ran.push(migration.id)
  }
  return ran
}
