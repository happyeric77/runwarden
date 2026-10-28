import { defineConfig } from 'vitest/config';

// Integration tests run against a real Postgres (embedded-postgres binaries);
// they are excluded from the default unit run (see vitest.config.ts).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
