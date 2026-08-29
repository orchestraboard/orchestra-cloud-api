import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, posix } from 'node:path'
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
 * Reading only `hub-entry.js`'s own text is NOT enough: tsup's code
 * splitting means most of the actual bundle lives in separate chunk files
 * that `hub-entry.js` merely imports (`pg-*.js`, `server-*.js`,
 * `migrations-*.js`, and whatever those in turn import). A stray import
 * anywhere in that reachable set — e.g. someone adding `import
 * './daemon.js'` to hub-entry.ts — would land the native deps in a NEW
 * chunk that `hub-entry.js` statically imports, while `hub-entry.js`'s own
 * text stays clean. So this walks the real module graph from
 * `hub-entry.js`, following every relative import/re-export/dynamic-import
 * specifier within `outDir`, and scans the FULL reachable set.
 *
 * The check is for a QUOTED import specifier (`'better-sqlite3'` /
 * `"better-sqlite3"`), not a bare substring: src/hub/server.ts has a doc
 * comment that mentions "better-sqlite3" in prose, and esbuild's
 * non-minified output preserves comments, so a bare substring match would
 * false-positive on that comment rather than on an actual import.
 */
describe('built hub entrypoint', () => {
  let outDir: string
  let reachable: Map<string, string> // relative filename -> contents

  beforeAll(async () => {
    // Inside the repo, not the OS temp dir: the emitted chunks import `pg` and
    // `fastify` as externals, which only resolve from a path under this node_modules.
    outDir = await mkdtemp(join(repoRoot, 'node_modules', '.hub-entry-build-'))
    await run(join(repoRoot, 'node_modules/.bin/tsup'), ['--outDir', outDir], { cwd: repoRoot })
    reachable = await collectReachableChunks(outDir, 'hub-entry.js')
  }, 120_000)

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  it('walks past the entry file into its imported chunks', () => {
    // A walk that only finds the entry file itself is silently broken the
    // same way the substring-only version of this test was: it would pass
    // even if a native dep were reachable through an imported chunk.
    expect(reachable.size).toBeGreaterThan(1)
    expect(reachable.has('hub-entry.js')).toBe(true)
  })

  it('does not reference better-sqlite3 anywhere in the reachable module graph', () => {
    for (const [file, contents] of reachable) {
      expect(contents, `${file} should not reference better-sqlite3`).not.toMatch(/['"]better-sqlite3['"]/)
    }
  })

  it('does not reference node-pty anywhere in the reachable module graph', () => {
    for (const [file, contents] of reachable) {
      expect(contents, `${file} should not reference node-pty`).not.toMatch(/['"]node-pty['"]/)
    }
  })
})

/**
 * Breadth-first walk of the real, on-disk module graph starting at `entryFile`
 * (a path relative to `outDir`). Follows every relative specifier — static
 * `import`/`export ... from`, and dynamic `import(...)` — found in each file's
 * text; ignores bare specifiers (`"pg"`, `"fastify"`, ...) since those are
 * externals that don't live under `outDir`. `cli.js` is never on this path
 * (hub-entry.ts doesn't import it), so unlike the migrations-build test this
 * walk never needs to special-case it.
 */
async function collectReachableChunks(outDir: string, entryFile: string): Promise<Map<string, string>> {
  // Three ways a relative specifier shows up in esbuild's output:
  //   import "./chunk.js"                  (bare side-effect import, no `from`)
  //   import { X } from "./chunk.js"       (also matches `export { X } from ...`)
  //   import("./chunk.js")                 (dynamic import)
  // The first alternative is anchored to line start (`m` flag) so it only
  // matches a real bare-import statement, not "import" appearing mid-line.
  const importSpecifier = /(?:^\s*import\s*|\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/gm

  const visited = new Map<string, string>()
  const queue = [entryFile]

  while (queue.length > 0) {
    const relPath = queue.shift()!
    if (visited.has(relPath)) continue

    const contents = await readFile(join(outDir, relPath), 'utf8')
    visited.set(relPath, contents)

    for (const match of contents.matchAll(importSpecifier)) {
      const resolved = resolveRelativeSpecifier(relPath, match[1])
      if (!visited.has(resolved)) queue.push(resolved)
    }
  }

  return visited
}

/**
 * Resolves `specifier` (e.g. `./pg-XSTFIKQQ.js`) relative to `fromRelPath`'s
 * directory. Both are posix-style paths relative to `outDir` — esbuild always
 * emits `/`-separated specifiers regardless of host OS, and every path this
 * function ever sees originates from one of those specifiers (or the initial
 * entry filename), so `path.posix` is correct here even on Windows.
 */
function resolveRelativeSpecifier(fromRelPath: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(fromRelPath), specifier))
}
