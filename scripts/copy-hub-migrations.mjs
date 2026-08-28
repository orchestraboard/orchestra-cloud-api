import { cp, mkdir } from 'node:fs/promises'

await mkdir('dist/hub/migrations', { recursive: true })
await cp('src/hub/migrations', 'dist/hub/migrations', { recursive: true })
console.log('copied hub migrations to dist/hub/migrations')
