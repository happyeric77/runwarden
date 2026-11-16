import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { AgentRuntimeError } from '../contracts/errors.js';
import type {
  BudgetExceededLimit,
  PolicyDecision,
} from '../contracts/policy.js';
import type {
  AgentRuntime,
  AwaitingApprovalRequest,
  BudgetRequest,
  InvocationRecord,
  InvocationResult,
  InvocationUsage,
  PendingToolCall,
} from '../contracts/runtime.js';
import type { DatabaseHandle } from '../db/client.js';
import { insertPolicyDecision } from '../db/repositories/decisions.js';
import {
  claimInvocations,
  getInvocationRowById,
  heartbeatInvocation,
  markInvocationAwaitingApproval,
  markInvocationFailed,
  markInvocationSucceeded,
  toPendingToolCall,
  toRecord,
  type ParkRequest,
} from '../db/repositories/invocations.js';
import {
  claimToolCallAudit,
  completeToolCallAudit,
} from '../db/repositories/tool-call-audits.js';
import type { InvocationRow } from '../db/schema.js';
import { RUNTIME_INTERNALS, type RuntimeInternals } from '../define-runtime.js';

export interface RunWorkerOptions {
  runtime: {
    engine: AgentRuntime;
    readonly [RUNTIME_INTERNALS]?: RuntimeInternals;
  };
  db: DatabaseHandle;
  workerId?: string;
  leaseTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  retryDelayMs?: number;
  pollIdleMs?: number;
  pollActiveMs?: number;
  onSucceeded?: (
    invocation: InvocationRecord,
    result: InvocationResult,
  ) => Promise<void>;
  onFailed?: (
    invocation: InvocationRecord,
    error: AgentRuntimeError,
  ) => Promise<void>;
  onAwaitingApproval?: (
    invocation: InvocationRecord,
    request: AwaitingApprovalRequest,
  ) => Promise<void>;
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toAgentError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) return error;
  return new AgentRuntimeError(
    'failure',
    error instanceof Error ? error.message : String(error),
    { code: 'execution_failed' },
    error instanceof Error ? { cause: error } : {},
  );
}

function errorCode(error: AgentRuntimeError): string {
  const code = error.diagnostics.code;
  return typeof code === 'string' ? code : 'execution_failed';
}

function pendingFromError(error: AgentRuntimeError): PendingToolCall {
  const pending = toPendingToolCall(error.diagnostics.pendingToolCall);
  if (pending) return pending;
  const toolName = error.diagnostics.toolName;
  return {
    toolName: typeof toolName === 'string' ? toolName : 'unknown',
    input: undefined,
  };
}

function budgetRequestFromError(
  error: AgentRuntimeError,
  runId: string,
): BudgetRequest | undefined {
  const limits = error.diagnostics.limits;
  if (!Array.isArray(limits) || !error.usage) return undefined;
  return {
    requestId: runId,
    limits: limits as BudgetExceededLimit[],
    usage: error.usage,
  };
}

function auditFailureError(
  cause: unknown,
  usage: InvocationUsage | undefined,
  nonRetryable = false,
): AgentRuntimeError {
  return new AgentRuntimeError(
    'failure',
    'Policy audit persistence failed',
    {
      code: 'audit_persistence_failed',
      auditFailure: 'Policy audit persistence failed',
      ...(nonRetryable ? { retryable: false } : {}),
    },
    { cause, ...(usage ? { usage } : {}) },
  );
}

export function runWorker(options: RunWorkerOptions): WorkerHandle {
  const workerId =
    options.workerId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
  const leaseTimeoutMs = options.leaseTimeoutMs ?? 120_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  const pollIdleMs = options.pollIdleMs ?? 500;
  const pollActiveMs = options.pollActiveMs ?? 250;
  const db = options.db.db;
  const internals = options.runtime[RUNTIME_INTERNALS];

  let stopped = false;

  function guardLease(row: InvocationRow) {
    let lost = false;
    async function beat(): Promise<boolean> {
      try {
        const owned = await heartbeatInvocation(
          db,
          row.id,
          workerId,
          row.activeRunId!,
          leaseTimeoutMs,
        );
        if (!owned) lost = true;
        return owned && !lost;
      } catch {
        return false;
      }
    }
    const interval = setInterval(() => void beat(), heartbeatIntervalMs);
    interval.unref?.();
    return {
      beat,
      get isLost() {
        return lost;
      },
      stop: () => clearInterval(interval),
    };
  }

  async function executeOne(
    row: InvocationRow,
    lease: ReturnType<typeof guardLease>,
  ): Promise<void> {
    const record = toRecord(row);
    const auditWrites: Promise<void>[] = [];
    let auditError: unknown;
    const unsubscribe = internals?.onPolicyDecision(
      (decision: PolicyDecision) => {
        if (
          decision.invocationId !== String(row.id) ||
          decision.runId !== row.activeRunId
        )
          return;
        auditWrites.push(
          insertPolicyDecision(db, decision).catch((error) => {
            auditError = error;
          }),
        );
      },
    );
    const auditIds = new Map<string, number>();
    const unsubscribeAudit = internals?.onToolCallAudit?.(async (event) => {
      if (
        event.invocationId !== String(row.id) ||
        event.runId !== row.activeRunId
      )
        return;
      if (event.phase === 'started') {
        const auditId = await claimToolCallAudit(db, {
          invocationId: event.invocationId,
          scope: event.scope,
          runId: event.runId,
          dispatchId: event.dispatchId,
          toolName: event.toolName,
          idempotencyKey: event.idempotencyKey,
          requestSnapshot: event.input ?? null,
          metadata: event.toolCallId
            ? { toolCallId: event.toolCallId }
            : undefined,
        });
        auditIds.set(event.dispatchId, auditId);
        return;
      }
      const auditId = auditIds.get(event.dispatchId);
      if (auditId === undefined)
        throw new Error('Tool audit completion has no started event');
      const completed = await completeToolCallAudit(
        db,
        auditId,
        event.phase,
        event.errorCode,
        event.runId,
        event.dispatchId,
      );
      if (!completed)
        throw new Error('Tool audit completion lost its dispatch claim');
      auditIds.delete(event.dispatchId);
    });
    try {
      let result: InvocationResult | undefined;
      let invocationError: unknown;
      try {
        result = await options.runtime.engine.invoke({
          ...row.input,
          invocationId: String(row.id),
          runId: row.activeRunId!,
          approvedToolCall: toPendingToolCall(row.pendingToolCall),
          ...(row.budgetGrants ? { budgetGrants: row.budgetGrants } : {}),
          budgetParkable: true,
        });
      } catch (error) {
        invocationError = error;
      } finally {
        unsubscribe?.();
        unsubscribeAudit?.();
        await Promise.all(auditWrites);
      }
      if (auditError) {
        const budgetError =
          invocationError === undefined
            ? undefined
            : toAgentError(invocationError);
        const code = budgetError ? errorCode(budgetError) : undefined;
        if (budgetError && code === 'budget_exceeded') {
          budgetError.diagnostics.auditFailure =
            'Policy audit persistence failed';
          throw budgetError;
        }
        // A park is only published with its durable audit; never park unaudited.
        throw auditFailureError(
          auditError,
          budgetError?.usage,
          code === 'budget_approval_required',
        );
      }
      if (invocationError !== undefined) throw invocationError;
      if (!result) {
        throw new AgentRuntimeError(
          'failure',
          'Native runtime returned no invocation result',
        );
      }
      if (lease.isLost) return;
      const marked = await markInvocationSucceeded(
        db,
        row.id,
        workerId,
        row.activeRunId!,
        {
          resultText: result.text,
          resultMessages: result.messages,
          usage: result.usage,
          provider: result.provider,
          model: result.model,
        },
      );
      if (marked) {
        const settledRecord = await getInvocationRowById(
          db,
          String(row.id),
        ).then(
          (settledRow) =>
            settledRow
              ? toRecord(settledRow)
              : {
                  ...record,
                  status: 'succeeded' as const,
                  resultText: result.text,
                },
          () => ({
            ...record,
            status: 'succeeded' as const,
            resultText: result.text,
          }),
        );
        await internals?.notifyInvocationSettled?.(settledRecord);
        await options.onSucceeded?.(
          { ...record, status: 'succeeded', resultText: result.text },
          result,
        );
      }
    } catch (error) {
      if (lease.isLost) return;
      const agentError = toAgentError(error);
      const code = errorCode(agentError);
      if (code === 'approval_required') {
        const pendingToolCall = pendingFromError(agentError);
        const parked = await park(row, lease, {
          kind: 'tool',
          toolCall: pendingToolCall,
        });
        if (parked) {
          await options.onAwaitingApproval?.(parked, {
            kind: 'tool',
            toolCall: pendingToolCall,
          });
        }
        return;
      }
      if (code === 'budget_approval_required') {
        const budgetRequest = budgetRequestFromError(
          agentError,
          row.activeRunId!,
        );
        if (!budgetRequest) {
          await settleFailure(row, agentError);
          return;
        }
        const detail = {
          ...(agentError.diagnostics.effectiveLimits
            ? { effectiveLimits: agentError.diagnostics.effectiveLimits }
            : {}),
          ...(agentError.diagnostics.grants
            ? { grants: agentError.diagnostics.grants }
            : {}),
        };
        let parked: InvocationRecord | undefined;
        try {
          parked = await park(row, lease, {
            kind: 'budget',
            request: budgetRequest,
            detail,
          });
        } catch (parkError) {
          await settleFailure(
            row,
            auditFailureError(parkError, agentError.usage),
            true,
          );
          return;
        }
        if (parked) {
          await options.onAwaitingApproval?.(parked, {
            kind: 'budget',
            budgetRequest,
          });
        }
        return;
      }
      await settleFailure(row, agentError);
    }
  }

  async function park(
    row: InvocationRow,
    lease: ReturnType<typeof guardLease>,
    request: ParkRequest,
  ): Promise<InvocationRecord | undefined> {
    if (lease.isLost) return undefined;
    const parked = await markInvocationAwaitingApproval(
      db,
      row.id,
      workerId,
      row.activeRunId!,
      request,
    );
    return parked ? toRecord(parked) : undefined;
  }

  async function settleFailure(
    row: InvocationRow,
    agentError: AgentRuntimeError,
    nonRetryable = false,
  ): Promise<void> {
    const updated = await markInvocationFailed(
      db,
      row.id,
      workerId,
      row.activeRunId!,
      { code: errorCode(agentError), message: agentError.message },
      retryDelayMs,
      {
        ...(agentError.usage ? { usage: agentError.usage } : {}),
        ...(nonRetryable ||
        agentError.diagnostics.retryable === false ||
        errorCode(agentError) === 'budget_exceeded'
          ? { retryable: false }
          : {}),
      },
    );
    if (updated?.status === 'failed') {
      await internals?.notifyInvocationSettled?.(toRecord(updated));
      await options.onFailed?.(toRecord(updated), agentError);
    }
  }

  const loop = (async () => {
    while (!stopped) {
      // Minted outside the claim error path on purpose: a generateRunId
      // that throws or returns a non-UUID is a configuration error and
      // must fail the worker loudly, not spin in the retry loop.
      let claimRunId: string | undefined;
      if (internals?.generateRunId) {
        claimRunId = internals.generateRunId();
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            claimRunId,
          )
        ) {
          throw new Error(
            `generateRunId must return a UUID string, got: ${claimRunId}`,
          );
        }
      }
      let claimed: {
        row: InvocationRow;
        lease: ReturnType<typeof guardLease>;
      }[] = [];
      try {
        try {
          const result = await claimInvocations(db, workerId, {
            leaseTimeoutMs,
            // Execution is serial, so only claim work we can heartbeat now.
            maxBatchSize: 1,
            runId: claimRunId,
          });
          claimed = result.claimed.map((row) => ({
            row,
            lease: guardLease(row),
          }));
          for (const exhaustedRow of result.exhausted) {
            await internals?.notifyInvocationSettled?.(toRecord(exhaustedRow));
          }
        } catch {
          await sleep(pollIdleMs);
          continue;
        }
        for (const { row, lease } of claimed) {
          if (stopped) break;
          if (!(await lease.beat())) continue;
          if (stopped) break;
          await executeOne(row, lease);
        }
      } finally {
        for (const { lease } of claimed) lease.stop();
      }
      await sleep(claimed.length === 0 ? pollIdleMs : pollActiveMs);
    }
  })();

  // The loop can reject long before anyone calls stop() (a generateRunId
  // failure is the first-turn case). Without a handler attached now, Node
  // treats that as an unhandled rejection and kills the process before
  // stop() can observe it. Awaiting `loop` in stop() still sees the
  // rejection; this only marks it handled in the meantime.
  loop.catch(() => {});

  return {
    async stop(): Promise<void> {
      stopped = true;
      await loop;
    },
  };
}
