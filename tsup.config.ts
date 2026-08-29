import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/hub-entry.ts'],
  format: ['esm'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
})
