import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { AgentRuntimeError } from '../../contracts/errors.js';
import type { BudgetGrant } from '../../contracts/policy.js';
import {
  accumulateBudgetGrants,
  effectiveBudgetLimits,
  validateBudgetGrant,
  type BudgetLimits,
} from '../../runtime/budget.js';
import type { Database } from '../client.js';
import type { InvocationRow } from '../schema.js';
import {
  mapRow,
  toBudgetGrants,
  toBudgetRequest,
  toPendingToolCall,
} from './invocations.js';

export async function listAwaitingApprovalRows(
  db: Database,
  scope?: string,
): Promise<InvocationRow[]> {
  const result =
    scope !== undefined
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
  /** Additional quota for a budget approval. Rejected on tool approvals. */
  grant?: BudgetGrant;
  /** The parked run ID of the budget request being resolved. */
  requestId?: string;
}

export type ApprovalResolution =
  | { outcome: 'resolved'; row: InvocationRow }
  | { outcome: 'not_found' }
  | { outcome: 'not_awaiting'; row: InvocationRow }
  | { outcome: 'stale_request'; row: InvocationRow };

const resolvedByDetail = (options: ApprovalResolutionOptions) => ({
  ...(options.resolvedBy ? { resolvedBy: options.resolvedBy } : {}),
  ...(options.note ? { note: options.note } : {}),
});

// The state change and its audit row commit or roll back together.
export async function resolveInvocationApproval(
  db: Database,
  id: string,
  resolution: 'approved' | 'rejected',
  options: ApprovalResolutionOptions = {},
  configuredBudget: BudgetLimits = {},
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

    const budgetRequest = toBudgetRequest(row.pendingBudgetRequest);
    if (budgetRequest) {
      // A stale decision must not touch a newer park.
      if (!options.requestId || options.requestId !== budgetRequest.requestId) {
        return { outcome: 'stale_request', row } as const;
      }
      const grants = toBudgetGrants(row.budgetGrants);
      const detail: Record<string, unknown> = {
        event: resolution,
        requestId: budgetRequest.requestId,
        limits: budgetRequest.limits,
        grants: grants ?? null,
        ...resolvedByDetail(options),
      };
      if (resolution === 'approved') {
        const grant = validateBudgetGrant(options.grant, configuredBudget);
        const total = accumulateBudgetGrants(grants, grant);
        const effectiveLimits = effectiveBudgetLimits(configuredBudget, total);
        detail['grant'] = grant;
        detail['grants'] = total;
        detail['effectiveLimits'] = effectiveLimits;
        await insertResolutionAudit(
          tx,
          row,
          budgetRequest.requestId,
          resolution,
          detail,
        );
        const updated = await tx.execute(sql`
          update agent_runtime.invocations
          set status = 'pending',
              next_attempt_at = now(),
              budget_grants = ${JSON.stringify(total)}::jsonb,
              pending_budget_request = null,
              last_error_code = null,
              last_error_message = null,
              updated_at = now()
          where id = ${row.id}
          returning *
        `);
        return {
          outcome: 'resolved',
          row: mapRow(updated.rows[0] as Record<string, unknown>),
        } as const;
      }

      detail['effectiveLimits'] = effectiveBudgetLimits(
        configuredBudget,
        grants,
      );
      await insertResolutionAudit(
        tx,
        row,
        budgetRequest.requestId,
        resolution,
        detail,
      );
      const updated = await tx.execute(sql`
        update agent_runtime.invocations
        set status = 'failed',
            pending_budget_request = null,
            last_error_code = 'budget_exceeded',
            last_error_message = ${options.note ?? 'Budget approval rejected'},
            failed_at = now(),
            completed_at = now(),
            updated_at = now()
        where id = ${row.id}
        returning *
      `);
      return {
        outcome: 'resolved',
        row: mapRow(updated.rows[0] as Record<string, unknown>),
      } as const;
    }

    if (options.grant !== undefined) {
      throw new AgentRuntimeError(
        'failure',
        'A grant is only valid when approving a budget request',
        { code: 'invalid_budget_grant' },
      );
    }
    const pending = toPendingToolCall(row.pendingToolCall);
    const detail: Record<string, unknown> = {
      toolInput: pending?.input ?? null,
      ...resolvedByDetail(options),
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

async function insertResolutionAudit(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  row: InvocationRow,
  requestId: string,
  decision: 'approved' | 'rejected',
  detail: Record<string, unknown>,
): Promise<void> {
  await tx.execute(sql`
    insert into agent_runtime.policy_decisions
      (scope, invocation_id, run_id, tool_name, rule, decision, detail)
    values (
      ${row.scope},
      ${row.id},
      ${requestId},
      null,
      'budget',
      ${decision},
      ${JSON.stringify(detail)}::jsonb
    )
  `);
}
