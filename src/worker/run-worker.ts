import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { AgentRuntimeError } from '../contracts/errors';
import type { PolicyDecision } from '../contracts/policy';
import type {
  AgentRuntime,
  InvocationRecord,
  InvocationResult,
} from '../contracts/runtime';
import type { DatabaseHandle } from '../db/client';
import { insertPolicyDecision } from '../db/repositories/decisions';
import {
  claimInvocations,
  heartbeatInvocation,
  markInvocationFailed,
  markInvocationSucceeded,
  toRecord,
} from '../db/repositories/invocations';
import type { InvocationRow } from '../db/schema';
import { RUNTIME_INTERNALS, type RuntimeInternals } from '../define-runtime';

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
        });
      } finally {
        unsubscribe?.();
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
