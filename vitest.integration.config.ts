import { defineConfig } from 'vitest/config';

// Keep real-Postgres tests separate so unit runs need no database.
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
