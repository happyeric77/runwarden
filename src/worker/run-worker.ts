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
  runtime: { engine: AgentRuntime };
  db: DatabaseHandle;
  workerId?: string;
  /** Default `120_000`. */
  leaseTimeoutMs?: number;
  /** Default `30_000`. */
  heartbeatIntervalMs?: number;
  /** Default `60_000`. */
  retryDelayMs?: number;
  /** Default `25`. */
  maxBatchSize?: number;
  /** Default `500`. */
  pollIdleMs?: number;
  /** Default `250`. */
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
  const maxBatchSize = options.maxBatchSize ?? 25;
  const pollIdleMs = options.pollIdleMs ?? 500;
  const pollActiveMs = options.pollActiveMs ?? 250;
  const db = options.db.db;
  const internals = (
    options.runtime as { [RUNTIME_INTERNALS]?: RuntimeInternals }
  )[RUNTIME_INTERNALS];

  let stopped = false;

  async function executeOne(row: InvocationRow): Promise<void> {
    const record = toRecord(row);
    const unsubscribe = internals?.onPolicyDecision(
      (decision: PolicyDecision) => {
        if (decision.invocationId !== String(row.id)) return;
        // Decision persistence must not fail the invocation it describes.
        void insertPolicyDecision(db, decision).catch(() => undefined);
      },
    );
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void heartbeatInvocation(db, row.id, workerId, leaseTimeoutMs)
        .then((ok) => {
          if (!ok) leaseLost = true;
        })
        .catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
    try {
      const result = await options.runtime.engine.invoke({
        ...row.input,
        invocationId: String(row.id),
        runId: row.activeRunId!,
      });
      if (leaseLost) return;
      const marked = await markInvocationSucceeded(db, row.id, workerId, {
        resultText: result.text,
        provider: result.provider,
        model: result.model,
      });
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
        { code: errorCode(agentError), message: agentError.message },
        retryDelayMs,
      );
      if (updated?.status === 'failed') {
        await options.onFailed?.(toRecord(updated), agentError);
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe?.();
    }
  }

  const loop = (async () => {
    while (!stopped) {
      let claimed: InvocationRow[] = [];
      try {
        claimed = await claimInvocations(db, workerId, {
          leaseTimeoutMs,
          maxBatchSize,
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
