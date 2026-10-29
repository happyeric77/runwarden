import { sql } from 'drizzle-orm';

import type { Database } from '../client';

export interface ToolCallAuditClaim {
  invocationId: string;
  scope: string;
  runId: string;
  toolName: string;
  idempotencyKey: string;
  requestSnapshot: unknown;
  metadata?: Record<string, unknown>;
}

// One row per call identity: a redispatch reclaims the existing row.
export async function claimToolCallAudit(
  db: Database,
  claim: ToolCallAuditClaim,
): Promise<number> {
  const inserted = await db.execute(sql`
    insert into agent_runtime.tool_call_audits
      (invocation_id, scope, run_id, tool_name, idempotency_key, status,
       requested_at, request_snapshot, metadata)
    values (
      ${claim.invocationId},
      ${claim.scope},
      ${claim.runId},
      ${claim.toolName},
      ${claim.idempotencyKey},
      'started',
      now(),
      ${JSON.stringify(claim.requestSnapshot)}::jsonb,
      ${claim.metadata ? JSON.stringify(claim.metadata) : null}::jsonb
    )
    on conflict (scope, tool_name, idempotency_key)
      where idempotency_key is not null
    do update set status = 'started',
      requested_at = now(),
      completed_at = null,
      error_code = null,
      run_id = excluded.run_id,
      request_snapshot = excluded.request_snapshot,
      metadata = excluded.metadata
    returning id
  `);
  const first = inserted.rows[0] as { id: number } | undefined;
  if (!first) throw new Error('tool call audit claim inserted no row');
  return Number(first.id);
}

export async function completeToolCallAudit(
  db: Database,
  id: number,
  status: 'succeeded' | 'failed',
  errorCode?: string,
): Promise<boolean> {
  const updated = await db.execute(sql`
    update agent_runtime.tool_call_audits
    set status = ${status},
        completed_at = now(),
        error_code = ${errorCode ?? null}
    where id = ${id}
    returning id
  `);
  return updated.rows.length > 0;
}
