import { defineConfig } from 'vitest/config'
import path from 'node:path'

// .mts, not .ts: this package is CommonJS, and Vite's native config loader
// rejects ESM syntax in a .ts config. Hence `import.meta.dirname`, not `__dirname`.
export default defineConfig({
  // fileParallelism: false — DB tests share one Neon `test` branch; keep them serial.
  test: { setupFiles: ['./vitest.setup.ts'], pool: 'forks', fileParallelism: false },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
})
