import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly kind: 'runwarden/database';
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

class DbHandle implements DatabaseHandle {
  readonly kind = 'runwarden/database' as const;

  constructor(
    readonly db: Database,
    readonly pool: Pool,
  ) {}

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDb(connectionString: string): DatabaseHandle {
  const pool = new Pool({ connectionString });
  pool.on('error', (error) => {
    // An idle client whose server went away must not crash the host.
    if (error.message.includes('terminating connection')) return;
    console.error('runwarden: database pool error', error);
  });
  return new DbHandle(drizzle(pool, { schema }), pool);
}
