import { pathToFileURL } from 'node:url'
import { hubEnv } from './hub/env.js'

/**
 * The hosted (Railway) process entrypoint. Deliberately imports only hub code:
 * `orchestra hub` and this entrypoint both start the same server, but this file
 * must never pull in `./cli.js`, `./daemon.js`, or `src/agent-os/**` — those
 * drag in `better-sqlite3` and `node-pty`, native addons the hub never touches.
 * `test/hub-entry-build.test.ts` builds this for real and checks the emitted
 * bundle for exactly that regression.
 *
 * `./hub/pg.js`, `./hub/migrations.js`, and `./hub/server.js` are imported
 * dynamically (matching `defaultStartHub` in hub-cli.ts) so they keep landing
 * in the same shared, dynamically-loaded chunks that `orchestra hub` already
 * uses — a static import here would force esbuild to split an extra facade
 * chunk for the async path alongside a second copy-by-reference chunk for the
 * static path, which is exactly what made `test/hub-build-migrations.test.ts`
 * find two modules exporting `hubMigrate` instead of one when this was tried.
 */
async function main(): Promise<void> {
  const env = hubEnv()

  const { createPgPool } = await import('./hub/pg.js')
  const { hubMigrate } = await import('./hub/migrations.js')
  const { buildHubServer } = await import('./hub/server.js')

  const sql = createPgPool(env.databaseUrl)
  const applied = await hubMigrate(sql)
  if (applied.length > 0) console.log(`applied hub migrations: ${applied.join(', ')}`)

  const server = buildHubServer(sql)
  await server.listen({ host: '0.0.0.0', port: env.port })
  console.log(`orchestra hub listening on 0.0.0.0:${env.port}`)
}

// Guard against running `main()` as a side effect of merely being imported
// (e.g. by a test that inspects the built bundle) — only run when this file
// is the process's actual entry module, the same test Node's own
// documentation recommends for ESM "run if main" checks.
const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
