import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DatabaseHandle } from './client';
import { initDb } from './init';
import { startTestPostgres, type TestPostgres } from './test-postgres';

describe('initDb', () => {
  let pg: TestPostgres;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    pg = await startTestPostgres();
    handle = createDb(pg.connectionString);
  });

  afterAll(async () => {
    await handle?.close();
    await pg?.stop();
  });

  it('initializes an empty database concurrently and is idempotent', async () => {
    const other = createDb(pg.connectionString);
    try {
      const results = await Promise.all([initDb(handle), initDb(other)]);
      expect(results.flatMap((result) => result.applied)).toEqual([
        '0000_init.sql',
      ]);
      expect(results.flatMap((result) => result.alreadyApplied)).toEqual([
        '0000_init.sql',
      ]);
    } finally {
      await other.close();
    }

    const tables = await handle.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'agent_runtime' order by table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'invocations',
      'policy_decisions',
      'schema_migrations',
      'tool_call_audits',
      'worker_leases',
    ]);

    const second = await initDb(handle);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['0000_init.sql']);

    const ledger = await handle.pool.query<{ count: string }>(
      'select count(*)::text as count from agent_runtime.schema_migrations',
    );
    expect(ledger.rows[0]?.count).toBe('1');
  });
});
