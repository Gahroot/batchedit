import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/main/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist']
  }
})
