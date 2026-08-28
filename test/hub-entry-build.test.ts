import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * This is the whole point of the hub/CLI entry split: `orchestra hub` (via
 * dist/cli.js) is allowed to drag in `better-sqlite3` and `node-pty` — the
 * local daemon needs both — but the hosted entrypoint (dist/hub-entry.js)
 * must never reference either, or a Railway container needs a native build
 * toolchain for dependencies it never calls. Asserting this by reading
 * source imports would just re-encode today's file layout; a real build
 * catches it the moment someone adds a stray import that pulls one in
 * transitively.
 *
 * The check is for a QUOTED import specifier (`'better-sqlite3'` /
 * `"better-sqlite3"`), not a bare substring: src/hub/server.ts has a doc
 * comment that mentions "better-sqlite3" in prose, and esbuild's
 * non-minified output preserves comments, so a bare substring match would
 * false-positive on that comment rather than on an actual import.
 */
describe('built hub entrypoint', () => {
  let outDir: string
  let entryContents: string

  beforeAll(async () => {
    // Inside the repo, not the OS temp dir: the emitted chunks import `pg` and
    // `fastify` as externals, which only resolve from a path under this node_modules.
    outDir = await mkdtemp(join(repoRoot, 'node_modules', '.hub-entry-build-'))
    await run(join(repoRoot, 'node_modules/.bin/tsup'), ['--outDir', outDir], { cwd: repoRoot })
    entryContents = await readFile(join(outDir, 'hub-entry.js'), 'utf8')
  }, 120_000)

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  it('does not reference better-sqlite3', () => {
    expect(entryContents).not.toMatch(/['"]better-sqlite3['"]/)
  })

  it('does not reference node-pty', () => {
    expect(entryContents).not.toMatch(/['"]node-pty['"]/)
  })

  it('is a non-trivial bundle, not an empty or failed build', () => {
    expect(entryContents.length).toBeGreaterThan(0)
  })
})
