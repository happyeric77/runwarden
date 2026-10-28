import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatabaseHandle } from './client';

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

// The ledger needs its schema before the first migration runs.
export async function initDb(
  handle: DatabaseHandle,
  options: InitOptions = {},
): Promise<InitResult> {
  const dir =
    options.migrationsDir ??
    fileURLToPath(new URL('../../migrations/', import.meta.url));
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const client = await handle.pool.connect();
  try {
    await client.query(
      `select pg_advisory_lock(hashtext('durable-agent-runtime:init'))`,
    );
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
        `select pg_advisory_unlock(hashtext('durable-agent-runtime:init'))`,
      );
    }
  } finally {
    client.release();
  }
}
