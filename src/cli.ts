#!/usr/bin/env tsx
import { createDb } from './db/client';
import { initDb } from './db/init';

const [command] = process.argv.slice(2);

if (command !== 'init') {
  console.error('Usage: durable-agent-runtime init');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const handle = createDb(connectionString);
try {
  const result = await initDb(handle);
  console.log(
    result.applied.length > 0
      ? `Applied migrations: ${result.applied.join(', ')}`
      : 'Database already up to date (no migrations applied).',
  );
} finally {
  await handle.close();
}
