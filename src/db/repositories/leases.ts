import { sql } from 'drizzle-orm';

import type { Database } from '../client';

export async function tryAcquireWorkerLease(
  db: Database,
  name: string,
  holderId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into agent_runtime.worker_leases (name, holder_id, acquired_at, heartbeat_at, expires_at)
    values (${name}, ${holderId}, now(), now(), now() + (${ttlMs} * interval '1 millisecond'))
    on conflict (name) do update
    set holder_id = excluded.holder_id,
        acquired_at = case
          when agent_runtime.worker_leases.holder_id = excluded.holder_id
          then agent_runtime.worker_leases.acquired_at
          else now()
        end,
        heartbeat_at = now(),
        expires_at = excluded.expires_at
    where agent_runtime.worker_leases.expires_at < now()
       or agent_runtime.worker_leases.holder_id = excluded.holder_id
    returning name
  `);
  return result.rows.length > 0;
}

export async function heartbeatWorkerLease(
  db: Database,
  name: string,
  holderId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    update agent_runtime.worker_leases
    set heartbeat_at = now(),
        expires_at = now() + (${ttlMs} * interval '1 millisecond')
    where name = ${name} and holder_id = ${holderId}
    returning name
  `);
  return result.rows.length > 0;
}

export async function releaseWorkerLease(
  db: Database,
  name: string,
  holderId: string,
): Promise<void> {
  await db.execute(sql`
    delete from agent_runtime.worker_leases
    where name = ${name} and holder_id = ${holderId}
  `);
}
