import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The SQL has to land next to the emitted migrations module, not next to where the
 * source sits. tsup builds a single entry (src/cli.ts) with ESM code splitting, so
 * src/hub/migrations.ts — reached only via a dynamic import — becomes a flat chunk
 * at the output ROOT (migrations-<hash>.js), and its
 * `new URL('./migrations/<file>', import.meta.url)` resolves to <outDir>/migrations.
 * Copying to <outDir>/hub/migrations instead is what made `orchestra hub` die at
 * boot with ENOENT. test/hub-build-migrations.test.ts holds this against a real build.
 */
const outDir = process.argv[2] ?? 'dist'
const target = join(outDir, 'migrations')

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp('src/hub/migrations', target, { recursive: true })
console.log(`copied hub migrations to ${target}`)
