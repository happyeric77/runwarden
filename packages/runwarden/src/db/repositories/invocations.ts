import { sql } from 'drizzle-orm';

import type { BudgetGrant } from '../../contracts/policy.js';
import type {
  BudgetRequest,
  InvocationInput,
  InvocationRecord,
  InvocationUsage,
  NeutralMessage,
  PendingToolCall,
  UsageStep,
} from '../../contracts/runtime.js';
import type { Database } from '../client.js';
import type { InvocationRow } from '../schema.js';

// Raw queries bypass Drizzle's bigint and column-name mapping.
export function mapRow(raw: Record<string, unknown>): InvocationRow {
  return {
    id: Number(raw.id),
    scope: raw.scope as string,
    conversationId: (raw.conversation_id as string | null) ?? null,
    orderingKey: (raw.ordering_key as string | null) ?? null,
    input: raw.input as InvocationInput,
    resultText: (raw.result_text as string | null) ?? null,
    resultMessages: (raw.result_messages as NeutralMessage[] | null) ?? null,
    inputTokens: raw.input_tokens == null ? null : Number(raw.input_tokens),
    outputTokens: raw.output_tokens == null ? null : Number(raw.output_tokens),
    cacheReadTokens:
      raw.cache_read_tokens == null ? null : Number(raw.cache_read_tokens),
    cacheWriteTokens:
      raw.cache_write_tokens == null ? null : Number(raw.cache_write_tokens),
    reasoningTokens:
      raw.reasoning_tokens == null ? null : Number(raw.reasoning_tokens),
    costUsd: raw.cost_usd == null ? null : Number(raw.cost_usd),
    usageSteps: (raw.usage_steps as UsageStep[] | null) ?? null,
    idempotencyKey: (raw.idempotency_key as string | null) ?? null,
    status: raw.status as InvocationRow['status'],
    attemptCount: Number(raw.attempt_count),
    maxAttempts: Number(raw.max_attempts),
    nextAttemptAt: raw.next_attempt_at as Date,
    claimedAt: (raw.claimed_at as Date | null) ?? null,
    claimedBy: (raw.claimed_by as string | null) ?? null,
    leaseHeartbeatAt: (raw.lease_heartbeat_at as Date | null) ?? null,
    leaseExpiresAt: (raw.lease_expires_at as Date | null) ?? null,
    activeRunId: (raw.active_run_id as string | null) ?? null,
    activeRunRegisteredAt:
      (raw.active_run_registered_at as Date | null) ?? null,
    pendingToolCall: raw.pending_tool_call ?? null,
    pendingBudgetRequest:
      (raw.pending_budget_request as BudgetRequest | null) ?? null,
    budgetGrants: (raw.budget_grants as BudgetGrant | null) ?? null,
    startedAt: (raw.started_at as Date | null) ?? null,
    completedAt: (raw.completed_at as Date | null) ?? null,
    failedAt: (raw.failed_at as Date | null) ?? null,
    provider: (raw.provider as string | null) ?? null,
    model: (raw.model as string | null) ?? null,
    lastErrorCode: (raw.last_error_code as string | null) ?? null,
    lastErrorMessage: (raw.last_error_message as string | null) ?? null,
    metadata: (raw.metadata as Record<string, unknown> | null) ?? null,
    createdAt: raw.created_at as Date,
    updatedAt: raw.updated_at as Date,
  };
}

export function toPendingToolCall(raw: unknown): PendingToolCall | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const toolName = (raw as { toolName?: unknown }).toolName;
  if (typeof toolName !== 'string') return undefined;
  return { toolName, input: (raw as { input?: unknown }).input };
}

export function toBudgetRequest(raw: unknown): BudgetRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const request = raw as Partial<BudgetRequest>;
  if (
    typeof request.requestId !== 'string' ||
    !Array.isArray(request.limits) ||
    typeof request.usage !== 'object' ||
    request.usage === null
  ) {
    return undefined;
  }
  return {
    requestId: request.requestId,
    limits: request.limits,
    usage: request.usage,
  };
}

export function toBudgetGrants(raw: unknown): BudgetGrant | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const grants = raw as BudgetGrant;
  if (grants.maxTokens === undefined && grants.maxCostUsd === undefined) {
    return undefined;
  }
  return {
    ...(grants.maxTokens !== undefined ? { maxTokens: grants.maxTokens } : {}),
    ...(grants.maxCostUsd !== undefined
      ? { maxCostUsd: grants.maxCostUsd }
      : {}),
  };
}

export function toRecord(row: InvocationRow): InvocationRecord {
  const pendingToolCall = toPendingToolCall(row.pendingToolCall);
  const pendingBudgetRequest = toBudgetRequest(row.pendingBudgetRequest);
  return {
    ...row.input,
    id: String(row.id),
    status: row.status,
    attemptCount: row.attemptCount,
    resultText: row.resultText ?? undefined,
    ...(pendingBudgetRequest
      ? { pendingApprovalKind: 'budget' as const, pendingBudgetRequest }
      : pendingToolCall
        ? { pendingApprovalKind: 'tool' as const, pendingToolCall }
        : {}),
    budgetGrants: toBudgetGrants(row.budgetGrants),
    lastErrorCode: row.lastErrorCode ?? undefined,
    lastErrorMessage: row.lastErrorMessage ?? undefined,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
  };
}

export async function enqueueInvocation(
  db: Database,
  input: InvocationInput,
): Promise<{ invocationId: string; created: boolean }> {
  const inserted = await db.execute(sql`
    insert into agent_runtime.invocations
      (scope, conversation_id, ordering_key, input, idempotency_key, max_attempts, metadata)
    values (
      ${input.scope},
      ${input.conversationId ?? null},
      ${input.orderingKey ?? null},
      ${JSON.stringify(input)}::jsonb,
      ${input.idempotencyKey ?? null},
      ${input.maxAttempts ?? 3},
      ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb
    )
    on conflict (scope, idempotency_key) where idempotency_key is not null
    do nothing
    returning id
  `);
  const first = inserted.rows[0] as { id: string } | undefined;
  if (first) return { invocationId: String(first.id), created: true };
  if (!input.idempotencyKey) {
    throw new Error('enqueue inserted no row without an idempotency key');
  }
  const existing = await db.execute(sql`
    select id from agent_runtime.invocations
    where scope = ${input.scope} and idempotency_key = ${input.idempotencyKey}
    limit 1
  `);
  const found = existing.rows[0] as { id: string } | undefined;
  if (!found) throw new Error('enqueue conflicted but no existing row found');
  return { invocationId: String(found.id), created: false };
}

export async function getInvocationRowById(
  db: Database,
  id: string,
): Promise<InvocationRow | undefined> {
  const result = await db.execute(
    sql`select * from agent_runtime.invocations where id = ${id} limit 1`,
  );
  const raw = result.rows[0] as Record<string, unknown> | undefined;
  return raw ? mapRow(raw) : undefined;
}

export interface ClaimOptions {
  leaseTimeoutMs: number;
  maxBatchSize: number;
  runId?: string;
}

export interface ClaimResult {
  claimed: InvocationRow[];
  exhausted: InvocationRow[];
}

// Recovery and exhausted-lease cleanup share the atomic claim statement,
// which also returns the rows it exhausted so callers can observe those
// terminal transitions.
export async function claimInvocations(
  db: Database,
  workerId: string,
  options: ClaimOptions,
): Promise<ClaimResult> {
  if (options.runId !== undefined && options.maxBatchSize !== 1) {
    throw new Error(
      'ClaimOptions.runId requires maxBatchSize of 1: a single runId cannot identify multiple attempts',
    );
  }
  const result = await db.execute(sql`
    with exhausted as (
      update agent_runtime.invocations
      set status = 'failed',
          failed_at = now(), completed_at = now(), updated_at = now(),
          last_error_code = 'lease_expired',
          last_error_message = 'Lease expired on the final attempt',
          ${CLEAR_CLAIM}
      where status = 'running' and lease_expires_at < now()
        and attempt_count >= max_attempts
      returning *
    ), candidate as (
      select inv.id
      from agent_runtime.invocations inv
      where inv.attempt_count < inv.max_attempts
        and (
          (inv.status = 'pending' and inv.next_attempt_at <= now())
          or (inv.status = 'running' and inv.lease_expires_at < now())
        )
        and (
          inv.ordering_key is null
          or not exists (
            select 1
            from agent_runtime.invocations pred
            where pred.scope = inv.scope
              and pred.ordering_key = inv.ordering_key
              and pred.id <> inv.id
              and pred.status in ('pending', 'running', 'awaiting_approval')
              and pred.id not in (select id from exhausted)
              and (
                pred.status = 'running'
                or pred.created_at < inv.created_at
                or (pred.created_at = inv.created_at and pred.id < inv.id)
              )
          )
        )
      order by inv.created_at asc, inv.id asc
      for update skip locked
      limit ${options.maxBatchSize}
    ), claimed as (
      update agent_runtime.invocations inv
      set status = 'running',
          attempt_count = inv.attempt_count + 1,
          claimed_at = now(),
          claimed_by = ${workerId},
          lease_heartbeat_at = now(),
          lease_expires_at = now() + (${options.leaseTimeoutMs} * interval '1 millisecond'),
          started_at = coalesce(inv.started_at, now()),
          active_run_id = coalesce(${options.runId ?? null}::uuid, gen_random_uuid()),
          active_run_registered_at = now(),
          updated_at = now()
      from candidate
      where inv.id = candidate.id
      returning inv.*
    )
    select 'claimed' as transition, claimed.* from claimed
    union all
    select 'exhausted' as transition, exhausted.* from exhausted
  `);
  const claimed: InvocationRow[] = [];
  const exhausted: InvocationRow[] = [];
  for (const raw of result.rows as Record<string, unknown>[]) {
    if (raw.transition === 'exhausted') {
      exhausted.push(mapRow(raw));
    } else {
      claimed.push(mapRow(raw));
    }
  }
  return { claimed, exhausted };
}

export async function heartbeatInvocation(
  db: Database,
  id: number,
  workerId: string,
  runId: string,
  leaseTimeoutMs: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    update agent_runtime.invocations
    set lease_heartbeat_at = now(),
        lease_expires_at = now() + (${leaseTimeoutMs} * interval '1 millisecond'),
        updated_at = now()
    where id = ${id} and claimed_by = ${workerId} and status = 'running'
      and active_run_id = ${runId}
    returning id
  `);
  return result.rows.length > 0;
}

const CLEAR_CLAIM = sql`
  claimed_at = null,
  claimed_by = null,
  lease_heartbeat_at = null,
  lease_expires_at = null
`;

export async function markInvocationSucceeded(
  db: Database,
  id: number,
  workerId: string,
  runId: string,
  result: {
    resultText: string;
    resultMessages?: NeutralMessage[];
    usage?: InvocationUsage;
    provider?: string;
    model?: string;
  },
): Promise<boolean> {
  const updated = await db.execute(sql`
    update agent_runtime.invocations
    set status = 'succeeded',
        result_text = ${result.resultText},
        result_messages = ${result.resultMessages ? JSON.stringify(result.resultMessages) : null}::jsonb,
        input_tokens = ${result.usage?.inputTokens ?? null},
        output_tokens = ${result.usage?.outputTokens ?? null},
        cache_read_tokens = ${result.usage?.cacheReadTokens ?? null},
        cache_write_tokens = ${result.usage?.cacheWriteTokens ?? null},
        reasoning_tokens = ${result.usage?.reasoningTokens ?? null},
        cost_usd = ${result.usage?.costUsd ?? null},
        usage_steps = ${result.usage ? JSON.stringify(result.usage.steps) : null}::jsonb,
        provider = ${result.provider ?? null},
        model = ${result.model ?? null},
        pending_tool_call = null,
        pending_budget_request = null,
        completed_at = now(),
        failed_at = null,
        ${CLEAR_CLAIM},
        updated_at = now()
    where id = ${id} and claimed_by = ${workerId} and status = 'running'
      and active_run_id = ${runId}
    returning id
  `);
  return updated.rows.length > 0;
}

// A parked run is a pause, not a failed attempt: hand the attempt back.
export type ParkRequest =
  | { kind: 'tool'; toolCall: PendingToolCall }
  | {
      kind: 'budget';
      request: BudgetRequest;
      detail?: Record<string, unknown>;
    };

export async function markInvocationAwaitingApproval(
  db: Database,
  id: number,
  workerId: string,
  runId: string,
  park: ParkRequest,
): Promise<InvocationRow | undefined> {
  return db.transaction(async (tx) => {
    const updated =
      park.kind === 'tool'
        ? await tx.execute(sql`
            update agent_runtime.invocations
            set status = 'awaiting_approval',
                pending_tool_call = ${JSON.stringify(park.toolCall)}::jsonb,
                pending_budget_request = null,
                attempt_count = greatest(attempt_count - 1, 0),
                last_error_code = null,
                last_error_message = null,
                ${CLEAR_CLAIM},
                updated_at = now()
            where id = ${id} and claimed_by = ${workerId} and status = 'running'
              and active_run_id = ${runId}
            returning *
          `)
        : await tx.execute(sql`
            update agent_runtime.invocations
            set status = 'awaiting_approval',
                pending_budget_request = ${JSON.stringify(park.request)}::jsonb,
                pending_tool_call = null,
                input_tokens = ${park.request.usage.inputTokens},
                output_tokens = ${park.request.usage.outputTokens},
                cache_read_tokens = ${park.request.usage.cacheReadTokens},
                cache_write_tokens = ${park.request.usage.cacheWriteTokens},
                reasoning_tokens = ${park.request.usage.reasoningTokens},
                cost_usd = ${park.request.usage.costUsd ?? null},
                usage_steps = ${JSON.stringify(park.request.usage.steps)}::jsonb,
                attempt_count = greatest(attempt_count - 1, 0),
                last_error_code = null,
                last_error_message = null,
                ${CLEAR_CLAIM},
                updated_at = now()
            where id = ${id} and claimed_by = ${workerId} and status = 'running'
              and active_run_id = ${runId}
            returning *
          `);
    const raw = updated.rows[0] as Record<string, unknown> | undefined;
    if (!raw) return undefined;
    // A park is published only with its durable audit: the insert shares the
    // transaction, so an audit failure leaves the run owned and un-parked.
    if (park.kind === 'budget') {
      await tx.execute(sql`
        insert into agent_runtime.policy_decisions
          (scope, invocation_id, run_id, tool_name, rule, decision, detail)
        values (
          ${raw.scope as string},
          ${id},
          ${park.request.requestId},
          null,
          'budget',
          'approval_requested',
          ${JSON.stringify({
            event: 'approval_requested',
            requestId: park.request.requestId,
            limits: park.request.limits,
            usage: park.request.usage,
            ...park.detail,
          })}::jsonb
        )
      `);
    }
    return mapRow(raw);
  });
}

// Claim already counted this attempt; failure must not increment it again.
export async function markInvocationFailed(
  db: Database,
  id: number,
  workerId: string,
  runId: string,
  error: { code: string; message: string },
  retryDelayMs: number,
  options: { usage?: InvocationUsage; retryable?: boolean } = {},
): Promise<InvocationRow | undefined> {
  const terminal = options.retryable === false;
  const updated = await db.execute(sql`
    update agent_runtime.invocations
    set status = (case when ${terminal} or attempt_count >= max_attempts then 'failed' else 'pending' end)::agent_runtime.invocation_status,
        next_attempt_at = case when ${terminal} or attempt_count >= max_attempts then now() else now() + (${retryDelayMs} * interval '1 millisecond') end,
        failed_at = case when ${terminal} or attempt_count >= max_attempts then now() else failed_at end,
        completed_at = case when ${terminal} or attempt_count >= max_attempts then now() else completed_at end,
        pending_tool_call = case when ${terminal} or attempt_count >= max_attempts then null else pending_tool_call end,
        pending_budget_request = case when ${terminal} or attempt_count >= max_attempts then null else pending_budget_request end,
        input_tokens = ${options.usage?.inputTokens ?? null},
        output_tokens = ${options.usage?.outputTokens ?? null},
        cache_read_tokens = ${options.usage?.cacheReadTokens ?? null},
        cache_write_tokens = ${options.usage?.cacheWriteTokens ?? null},
        reasoning_tokens = ${options.usage?.reasoningTokens ?? null},
        cost_usd = ${options.usage?.costUsd ?? null},
        usage_steps = ${options.usage ? JSON.stringify(options.usage.steps) : null}::jsonb,
        last_error_code = ${error.code},
        last_error_message = ${error.message},
        ${CLEAR_CLAIM},
        updated_at = now()
    where id = ${id} and claimed_by = ${workerId} and status = 'running'
      and active_run_id = ${runId}
    returning *
  `);
  const raw = updated.rows[0] as Record<string, unknown> | undefined;
  return raw ? mapRow(raw) : undefined;
}
