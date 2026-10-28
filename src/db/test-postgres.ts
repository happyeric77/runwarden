import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';

// The bundled native lib dir ships versioned files (libpq.so.5.18) without
// the soname links (libpq.so.5) the loader looks for; recreate them in a
// scratch dir and put both on LD_LIBRARY_PATH before spawning any binary.
let libraryPathReady = false;
function prepareLibraryPath(): void {
  if (libraryPathReady) return;
  libraryPathReady = true;
  const require = createRequire(import.meta.url);
  const embeddedEntry = require.resolve('embedded-postgres');
  const platformEntry = createRequire(embeddedEntry).resolve(
    '@embedded-postgres/linux-x64',
  );
  let dir = path.dirname(platformEntry);
  while (!existsSync(path.join(dir, 'native', 'lib'))) {
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error('embedded-postgres native lib not found');
    dir = parent;
  }
  const nativeLib = path.join(dir, 'native', 'lib');
  const scratch = path.join(tmpdir(), 'dar-pg-libs');
  mkdirSync(scratch, { recursive: true });
  for (const file of readdirSync(nativeLib)) {
    const match = /^(lib.+)\.so\.(\d+)\.\d+$/.exec(file);
    if (!match) continue;
    try {
      symlinkSync(
        path.join(nativeLib, file),
        path.join(scratch, `${match[1]}.so.${match[2]}`),
      );
    } catch {
      // Link already exists from an earlier run.
    }
  }
  process.env.LD_LIBRARY_PATH = [
    scratch,
    nativeLib,
    process.env.LD_LIBRARY_PATH ?? '',
  ]
    .filter(Boolean)
    .join(':');
}

export interface TestPostgres {
  connectionString: string;
  stop(): Promise<void>;
}

let counter = 0;

// Real Postgres binaries via embedded-postgres; pg-mem cannot reproduce
// SKIP LOCKED, partial indexes, or timestamptz semantics these tests need.
export async function startTestPostgres(): Promise<TestPostgres> {
  prepareLibraryPath();
  counter += 1;
  const port = 25_000 + Math.floor(Math.random() * 4_000) + counter;
  const databaseName = `dar_test_${counter}`;
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpdir(), `dar-pg-${port}`),
    user: 'postgres',
    password: 'password',
    port,
    persistent: false,
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
