import { tmpdir } from 'node:os';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';

export interface TestPostgres {
  connectionString: string;
  stop(): Promise<void>;
}

let counter = 0;

// Mocks cannot reproduce PostgreSQL locking and partial indexes.
export async function startTestPostgres(): Promise<TestPostgres> {
  counter += 1;
  const port = 25_000 + Math.floor(Math.random() * 4_000) + counter;
  const databaseName = `dar_test_${counter}`;
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpdir(), `dar-pg-${port}`),
    user: 'postgres',
    password: 'password',
    port,
    persistent: true,
    postgresFlags: process.platform === 'win32' ? [] : ['-k', tmpdir()],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(databaseName);
  return {
    connectionString: `postgres://postgres:password@localhost:${port}/${databaseName}`,
    stop: () => pg.stop(),
  };
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
