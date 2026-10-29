import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Database } from '../client';
import type { InvocationRow } from '../schema';
import { mapRow, toPendingToolCall } from './invocations';

export async function listAwaitingApprovalRows(
  db: Database,
  scope?: string,
): Promise<InvocationRow[]> {
  const result = scope
    ? await db.execute(sql`
        select * from agent_runtime.invocations
        where status = 'awaiting_approval' and scope = ${scope}
        order by created_at asc, id asc
      `)
    : await db.execute(sql`
        select * from agent_runtime.invocations
        where status = 'awaiting_approval'
        order by created_at asc, id asc
      `);
  return (result.rows as Record<string, unknown>[]).map(mapRow);
}

export interface ApprovalResolutionOptions {
  resolvedBy?: string;
  note?: string;
}

export type ApprovalResolution =
  | { outcome: 'resolved'; row: InvocationRow }
  | { outcome: 'not_found' }
  | { outcome: 'not_awaiting'; row: InvocationRow };

// The state change and its audit row commit or roll back together.
export async function resolveInvocationApproval(
  db: Database,
  id: string,
  resolution: 'approved' | 'rejected',
  options: ApprovalResolutionOptions = {},
): Promise<ApprovalResolution> {
  return db.transaction(async (tx) => {
    const selected = await tx.execute(sql`
      select * from agent_runtime.invocations where id = ${id} for update
    `);
    const raw = selected.rows[0] as Record<string, unknown> | undefined;
    if (!raw) return { outcome: 'not_found' } as const;
    const row = mapRow(raw);
    if (row.status !== 'awaiting_approval') {
      return { outcome: 'not_awaiting', row } as const;
    }

    const pending = toPendingToolCall(row.pendingToolCall);
    const detail: Record<string, unknown> = {
      toolInput: pending?.input ?? null,
      ...(options.resolvedBy ? { resolvedBy: options.resolvedBy } : {}),
      ...(options.note ? { note: options.note } : {}),
    };
    await tx.execute(sql`
      insert into agent_runtime.policy_decisions
        (scope, invocation_id, run_id, tool_name, rule, decision, detail)
      values (
        ${row.scope},
        ${row.id},
        ${row.activeRunId ?? randomUUID()},
        ${pending?.toolName ?? null},
        'require_approval',
        ${resolution},
        ${JSON.stringify(detail)}::jsonb
      )
    `);

    const updated =
      resolution === 'approved'
        ? await tx.execute(sql`
            update agent_runtime.invocations
            set status = 'pending',
                next_attempt_at = now(),
                last_error_code = null,
                last_error_message = null,
                updated_at = now()
            where id = ${row.id}
            returning *
          `)
        : await tx.execute(sql`
            update agent_runtime.invocations
            set status = 'cancelled',
                pending_tool_call = null,
                last_error_code = 'approval_rejected',
                last_error_message = ${options.note ?? 'Approval rejected'},
                failed_at = now(),
                completed_at = now(),
                updated_at = now()
            where id = ${row.id}
            returning *
          `);
    const updatedRaw = updated.rows[0] as Record<string, unknown>;
    return { outcome: 'resolved', row: mapRow(updatedRaw) } as const;
  });
}
