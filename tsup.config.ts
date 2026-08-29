import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/hub-entry.ts'],
  format: ['esm'],
  clean: true,
})
