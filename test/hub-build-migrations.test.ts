import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { PGlite } from '@electric-sql/pglite'
import type { HubSql } from '../src/hub/sql.js'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * The bug this guards: `orchestra hub` died at boot with ENOENT because the built
 * migration runner and the built `.sql` files ended up in different directories.
 * tsup emits `src/hub/migrations.ts` as a flat chunk at the output ROOT (it is only
 * ever reached through a dynamic import, so code splitting hoists it out of the
 * entry), which makes its `new URL('./migrations/...', import.meta.url)` resolve to
 * `<outDir>/migrations` — while the copy step was writing to `<outDir>/hub/migrations`.
 *
 * Asserting the two paths agree by inspection would just re-encode today's build
 * layout. So this builds for real and runs `hubMigrate` out of the artifact: if a
 * tsup upgrade, a config change, or a new entry point ever moves that chunk, the
 * migration read fails here instead of in production.
 */
describe('built hub artifact', () => {
  let outDir: string
  let built: { hubMigrate: (sql: HubSql) => Promise<string[]> }

  beforeAll(async () => {
    // Inside the repo, not the OS temp dir: the emitted chunks import `pg` and
    // `fastify` as externals, which only resolve from a path under this node_modules.
    outDir = await mkdtemp(join(repoRoot, 'node_modules', '.hub-build-'))
    await run(join(repoRoot, 'node_modules/.bin/tsup'), ['--outDir', outDir], { cwd: repoRoot })
    await run(process.execPath, ['scripts/copy-hub-migrations.mjs', outDir], { cwd: repoRoot })
    built = await importBuiltMigrations(outDir)
  }, 120_000)

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  it('resolves its .sql files and migrates a database', async () => {
    const sql = pglite()

    const applied = await built.hubMigrate(sql)
    expect(applied).toEqual(['001-hub-core', '002-hub-work', '003-hub-events', '004-hub-event-seq', '005-hub-entitlements', '006-cli-auth'])

    const tables = await sql.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      'hub_schema_migrations', 'orgs', 'boards', 'cards', 'mail', 'agents', 'org_events', 'org_event_seq',
    ]))

    expect(await built.hubMigrate(sql)).toEqual([])
  })
})

/**
 * Finds the emitted module by what it exports rather than by filename: the chunk
 * carries a content hash (`migrations-IGVXXSCP.js`) that changes on every edit.
 */
async function importBuiltMigrations(outDir: string): Promise<any> {
  // `cli.js` is the entry: importing it would run the commander program against
  // vitest's argv. Every other emitted `.js` is a split chunk and safe to load.
  const files = (await readdir(outDir)).filter((name) => name.endsWith('.js') && name !== 'cli.js')
  const matches: any[] = []
  const skipped: string[] = []
  for (const name of files) {
    // A sibling chunk that won't load (an unrelated external, say) must not decide
    // this test — the assertion below is what fails if the migrations chunk is the
    // one missing.
    let module: any
    try { module = await import(pathToFileURL(join(outDir, name)).href) }
    catch (error) { skipped.push(`${name} (${(error as Error).message})`); continue }
    if (typeof module.hubMigrate === 'function') matches.push(module)
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one built chunk exporting hubMigrate, found ${matches.length}. ` +
      `Loaded: ${files.join(', ')}. Failed to load: ${skipped.join(', ') || 'none'}`,
    )
  }
  return matches[0]
}

function pglite(): HubSql {
  const db = new PGlite()
  return {
    query: async (text, params) => {
      const result = await db.query(text, params ? [...params] : undefined)
      const rows = (result.rows ?? []) as any[]
      return { rows, rowCount: rows.length }
    },
  }
}
