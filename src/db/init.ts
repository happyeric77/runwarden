import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatabaseHandle } from './client.js';

export interface InitResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface InitOptions {
  migrationsDir?: string;
}

const LEDGER_DDL = `
  create table if not exists agent_runtime.schema_migrations (
    name text primary key,
    hash text not null,
    applied_at timestamptz not null default now()
  )
`;

// Source and unbundled builds keep init two levels below the package root;
// the bundled build flattens it into dist/, one level below.
const MIGRATIONS_DIR_CANDIDATES = ['../../migrations/', '../migrations/'];

async function defaultMigrationsDir(): Promise<string> {
  for (const candidate of MIGRATIONS_DIR_CANDIDATES) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    const files = await readdir(dir).catch(() => null);
    if (files?.some((file) => file.endsWith('.sql'))) return dir;
  }
  return fileURLToPath(new URL(MIGRATIONS_DIR_CANDIDATES[0], import.meta.url));
}

// The ledger needs its schema before the first migration runs.
export async function initDb(
  handle: DatabaseHandle,
  options: InitOptions = {},
): Promise<InitResult> {
  const dir = options.migrationsDir ?? (await defaultMigrationsDir());
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const client = await handle.pool.connect();
  try {
    await client.query(`select pg_advisory_lock(hashtext('runwarden:init'))`);
    try {
      await client.query('create schema if not exists agent_runtime');
      await client.query(LEDGER_DDL);
      const { rows } = await client.query<{ name: string }>(
        'select name from agent_runtime.schema_migrations',
      );
      const done = new Set(rows.map((row) => row.name));
      const applied: string[] = [];
      for (const file of files) {
        if (done.has(file)) continue;
        const text = await readFile(path.join(dir, file), 'utf8');
        const hash = createHash('sha256').update(text).digest('hex');
        await client.query('begin');
        try {
          for (const statement of text
            .split('--> statement-breakpoint')
            .map((part) => part.trim())
            .filter(Boolean)) {
            await client.query(statement);
          }
          await client.query(
            'insert into agent_runtime.schema_migrations (name, hash) values ($1, $2)',
            [file, hash],
          );
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
        applied.push(file);
      }
      return {
        applied,
        alreadyApplied: files.filter((file) => done.has(file)),
      };
    } finally {
      await client.query(
        `select pg_advisory_unlock(hashtext('runwarden:init'))`,
      );
    }
  } finally {
    client.release();
  }
}
