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

const PACKAGE_NAME = 'runwarden';

// Bundlers place this module at different depths, so depth counting is not
// reliable; locate the package by its own package.json instead. Searching
// relative depths can escape the package and pick up foreign migrations.
export async function resolveMigrationsDir(moduleUrl: string): Promise<string> {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifest = await readFile(path.join(dir, 'package.json'), 'utf8')
      .then((text) => JSON.parse(text) as { name?: string })
      .catch(() => null);
    if (manifest?.name === PACKAGE_NAME) {
      const migrationsDir = path.join(dir, 'migrations');
      const files = await readdir(migrationsDir).catch(() => null);
      if (files?.some((file) => file.endsWith('.sql'))) return migrationsDir;
      throw new Error(
        `runwarden: no .sql migrations found in ${migrationsDir}. ` +
          'The installation looks incomplete; reinstall runwarden or pass InitOptions.migrationsDir.',
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'runwarden: could not locate the runwarden package root from ' +
      `${fileURLToPath(moduleUrl)}. Pass InitOptions.migrationsDir to initDb.`,
  );
}

// The ledger needs its schema before the first migration runs.
export async function initDb(
  handle: DatabaseHandle,
  options: InitOptions = {},
): Promise<InitResult> {
  const dir =
    options.migrationsDir ?? (await resolveMigrationsDir(import.meta.url));
  const entries = await readdir(dir).catch(() => null);
  if (!entries) {
    throw new Error(
      `runwarden: migrations directory not found: ${dir}. ` +
        'Pass InitOptions.migrationsDir if the migrations live elsewhere.',
    );
  }
  const files = entries.filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(
      `runwarden: no .sql migrations found in ${dir}. ` +
        'Pass InitOptions.migrationsDir if the migrations live elsewhere.',
    );
  }
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
