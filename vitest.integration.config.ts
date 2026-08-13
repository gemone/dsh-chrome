import { defineConfig } from 'vitest/config'

// Integration tests launch a real headless Chrome. Skipped automatically unless
// DSH_CHROME_INTEGRATION=1 and a Chrome executable is discoverable.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    testTimeout: 60_000,
  },
})
