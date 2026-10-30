import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { AgentRuntimeError } from '../contracts/errors.js';
import type { PolicyDecision } from '../contracts/policy.js';
import type {
  AgentRuntime,
  InvocationRecord,
  InvocationResult,
  PendingToolCall,
} from '../contracts/runtime.js';
import type { DatabaseHandle } from '../db/client.js';
import { insertPolicyDecision } from '../db/repositories/decisions.js';
import {
  claimInvocations,
  heartbeatInvocation,
  markInvocationAwaitingApproval,
  markInvocationFailed,
  markInvocationSucceeded,
  toPendingToolCall,
  toRecord,
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
    pendingToolCall: PendingToolCall,
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

  async function executeOne(row: InvocationRow): Promise<void> {
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
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void heartbeatInvocation(
        db,
        row.id,
        workerId,
        row.activeRunId!,
        leaseTimeoutMs,
      )
        .then((ok) => {
          if (!ok) leaseLost = true;
        })
        .catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
    try {
      let result: InvocationResult;
      try {
        result = await options.runtime.engine.invoke({
          ...row.input,
          invocationId: String(row.id),
          runId: row.activeRunId!,
          approvedToolCall: toPendingToolCall(row.pendingToolCall),
        });
      } finally {
        unsubscribe?.();
        unsubscribeAudit?.();
        await Promise.all(auditWrites);
        if (auditError)
          throw new AgentRuntimeError(
            'failure',
            'Policy audit persistence failed',
            { code: 'audit_persistence_failed' },
            { cause: auditError },
          );
      }
      if (leaseLost) return;
      const marked = await markInvocationSucceeded(
        db,
        row.id,
        workerId,
        row.activeRunId!,
        {
          resultText: result.text,
          provider: result.provider,
          model: result.model,
        },
      );
      if (marked) {
        await options.onSucceeded?.(
          { ...record, status: 'succeeded', resultText: result.text },
          result,
        );
      }
    } catch (error) {
      if (leaseLost) return;
      const agentError = toAgentError(error);
      if (errorCode(agentError) === 'approval_required') {
        const pendingToolCall = pendingFromError(agentError);
        const parked = await markInvocationAwaitingApproval(
          db,
          row.id,
          workerId,
          row.activeRunId!,
          pendingToolCall,
        );
        if (parked) {
          await options.onAwaitingApproval?.(toRecord(parked), pendingToolCall);
        }
        return;
      }
      const updated = await markInvocationFailed(
        db,
        row.id,
        workerId,
        row.activeRunId!,
        { code: errorCode(agentError), message: agentError.message },
        retryDelayMs,
      );
      if (updated?.status === 'failed') {
        await options.onFailed?.(toRecord(updated), agentError);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  const loop = (async () => {
    while (!stopped) {
      let claimed: InvocationRow[] = [];
      try {
        claimed = await claimInvocations(db, workerId, {
          leaseTimeoutMs,
          // Execution is serial, so only claim work we can heartbeat now.
          maxBatchSize: 1,
        });
      } catch {
        await sleep(pollIdleMs);
        continue;
      }
      if (claimed.length === 0) {
        await sleep(pollIdleMs);
        continue;
      }
      for (const row of claimed) {
        if (stopped) break;
        await executeOne(row);
      }
      await sleep(pollActiveMs);
    }
  })();

  return {
    async stop(): Promise<void> {
      stopped = true;
      await loop;
    },
  };
}
