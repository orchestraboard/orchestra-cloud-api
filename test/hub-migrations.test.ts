import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { hubMigrate, splitStatements, HUB_MIGRATIONS } from '../src/hub/migrations.js'
import type { HubSql, HubSqlConnection, HubSqlPool } from '../src/hub/sql.js'

function pglite(): HubSql {
  const db = new PGlite()
  return { query: async (text, params) => {
    const r = await db.query(text, params ? [...params] : undefined)
    return { rows: (r.rows ?? []) as any[], rowCount: r.rows?.length ?? 0 }
  } }
}

/** Records every statement, and optionally fails the first one matching `failOn`. */
function recording(inner: HubSql, failOn?: RegExp): HubSql & { statements: string[] } {
  const statements: string[] = []
  let failed = false
  return {
    statements,
    query: async (text, params) => {
      statements.push(text)
      if (failOn && !failed && failOn.test(text)) {
        failed = true
        throw new Error('simulated mid-migration failure')
      }
      return inner.query(text, params)
    },
  }
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

  it('rolls a half-applied migration all the way back', async () => {
    const db = pglite()
    // 002 creates cards, then mail, then agents. Fail on the `mail` statement so the
    // migration dies with `cards` already created inside the transaction.
    const sql = recording(db, /CREATE TABLE IF NOT EXISTS mail/)

    await expect(hubMigrate(sql)).rejects.toThrow('simulated mid-migration failure')

    const recorded = await db.query<{ id: string }>('SELECT id FROM hub_schema_migrations ORDER BY id')
    expect(recorded.rows.map((row) => row.id)).toEqual(['001-hub-core'])

    // The whole failed migration is gone, not just the statements after the failure.
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    )
    const names = tables.rows.map((row) => row.table_name)
    expect(names).toContain('orgs')
    expect(names).not.toContain('cards')

    // And a clean retry against a repaired runner applies it in full.
    const retry = await hubMigrate(db)
    expect(retry).toEqual(['002-hub-work', '003-hub-events', '004-hub-event-seq', '005-hub-entitlements', '006-cli-auth', '007-hub-milestones'])
  })

  it('holds an advisory lock for the whole run and releases it, even on failure', async () => {
    const ok = recording(pglite())
    await hubMigrate(ok)
    expect(ok.statements[0]).toMatch(/pg_advisory_lock/)
    expect(ok.statements[ok.statements.length - 1]).toMatch(/pg_advisory_unlock/)

    const failing = recording(pglite(), /CREATE TABLE IF NOT EXISTS mail/)
    await expect(hubMigrate(failing)).rejects.toThrow()
    expect(failing.statements[failing.statements.length - 1]).toMatch(/pg_advisory_unlock/)
  })

  it('takes the lock and the transactions on one pooled connection', async () => {
    const db = pglite()
    const onConnection: string[] = []
    let released = false
    const pool: HubSqlPool = {
      query: async () => { throw new Error('hubMigrate must not query the pool directly') },
      connect: async (): Promise<HubSqlConnection> => ({
        query: async (text, params) => { onConnection.push(text); return db.query(text, params) },
        release: () => { released = true },
      }),
    }

    expect(await hubMigrate(pool)).toContain('001-hub-core')
    expect(released).toBe(true)
    expect(onConnection.filter((text) => /pg_advisory_lock/.test(text))).toHaveLength(1)
    expect(onConnection.filter((text) => text === 'BEGIN')).toHaveLength(HUB_MIGRATIONS.length)
    expect(onConnection.filter((text) => text === 'COMMIT')).toHaveLength(HUB_MIGRATIONS.length)
  })
})

describe('migration statement splitter', () => {
  it('does not split on a semicolon or a -- inside a string literal', () => {
    const statements = splitStatements(
      "INSERT INTO t (v) VALUES ('a; b -- not a comment');\nSELECT 1;",
    )
    expect(statements).toEqual(["INSERT INTO t (v) VALUES ('a; b -- not a comment')", 'SELECT 1'])
  })

  it('keeps a dollar-quoted function body intact', () => {
    const sql = [
      'CREATE FUNCTION bump() RETURNS trigger AS $$',
      'BEGIN',
      "  NEW.v := NEW.v + 1; -- inside the body",
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'SELECT 1;',
    ].join('\n')

    const statements = splitStatements(sql)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('NEW.v := NEW.v + 1; -- inside the body')
    expect(statements[0]).toContain('END;')
    expect(statements[1]).toBe('SELECT 1')
  })

  it('handles a named dollar-quote tag without mistaking $1 for one', () => {
    const statements = splitStatements("SELECT $tag$a;b$tag$; SELECT $1;")
    expect(statements).toEqual(['SELECT $tag$a;b$tag$', 'SELECT $1'])
  })

  it('strips line and nested block comments but keeps quoted identifiers', () => {
    const statements = splitStatements(
      '-- leading\nCREATE TABLE "odd;name" (id text); /* a /* nested */ comment */ SELECT 2;',
    )
    expect(statements).toEqual(['CREATE TABLE "odd;name" (id text)', 'SELECT 2'])
  })

  it('handles doubled quotes and E-string backslash escapes', () => {
    expect(splitStatements("SELECT 'it''s; fine'; SELECT 2;"))
      .toEqual(["SELECT 'it''s; fine'", 'SELECT 2'])
    expect(splitStatements("SELECT E'a\\'; b'; SELECT 2;"))
      .toEqual(["SELECT E'a\\'; b'", 'SELECT 2'])
  })

  it('refuses a malformed file instead of mis-splitting it', () => {
    expect(() => splitStatements("SELECT 'unterminated;")).toThrow(/unterminated string literal/)
    expect(() => splitStatements('SELECT $$body; ')).toThrow(/unterminated dollar-quoted string/)
    expect(() => splitStatements('/* open;')).toThrow(/unterminated block comment/)
  })
})
