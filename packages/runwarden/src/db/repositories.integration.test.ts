import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InvocationUsage } from '../contracts/runtime.js';
import { createDb, type DatabaseHandle } from './client.js';
import { initDb } from './init.js';
import {
  resolveInvocationApproval,
  type ApprovalResolution,
} from './repositories/approvals.js';
import {
  claimInvocations,
  enqueueInvocation,
  getInvocationRowById,
  heartbeatInvocation,
  markInvocationAwaitingApproval,
  markInvocationFailed,
  markInvocationSucceeded,
} from './repositories/invocations.js';
import {
  heartbeatWorkerLease,
  releaseWorkerLease,
  tryAcquireWorkerLease,
} from './repositories/leases.js';
import {
  claimToolCallAudit,
  completeToolCallAudit,
} from './repositories/tool-call-audits.js';
import { startTestPostgres, type TestPostgres } from './test-postgres.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function budgetUsage(
  inputTokens: number,
  outputTokens: number,
): InvocationUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costIncomplete: true,
    steps: [
      {
        provider: 'mock-provider',
        model: 'mock-model',
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        usageKnown: true,
        costKnown: false,
      },
    ],
  };
}

function resolvedRow(result: ApprovalResolution) {
  if (result.outcome !== 'resolved') {
    throw new Error(`expected resolved, got ${result.outcome}`);
  }
  return result.row;
}

function budgetLimit(accumulated: number, limit = 10) {
  return [
    {
      limitKind: 'tokens' as const,
      accumulated,
      limit,
      stepNumber: 1,
      completeness: 'complete' as const,
    },
  ];
}

describe('invocation repositories', () => {
  let pg: TestPostgres;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    pg = await startTestPostgres();
    handle = createDb(pg.connectionString);
    await initDb(handle);
  });

  afterAll(async () => {
    await handle?.close();
    await pg?.stop();
  });

  it('dedupes enqueue on (scope, idempotency_key)', async () => {
    const input = {
      scope: 'scope-dedupe',
      prompt: 'hello',
      idempotencyKey: 'key-1',
    };
    const first = await enqueueInvocation(handle.db, input);
    const second = await enqueueInvocation(handle.db, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.invocationId).toBe(first.invocationId);

    const other = await enqueueInvocation(handle.db, {
      ...input,
      idempotencyKey: 'key-2',
    });
    expect(other.invocationId).not.toBe(first.invocationId);

    const noKeyA = await enqueueInvocation(handle.db, {
      scope: 'scope-dedupe',
      prompt: 'no key',
    });
    const noKeyB = await enqueueInvocation(handle.db, {
      scope: 'scope-dedupe',
      prompt: 'no key',
    });
    expect(noKeyA.invocationId).not.toBe(noKeyB.invocationId);
  });

  it.each([false, true])(
    'fences reclaimed audit completions, same run: %s',
    async (sameRun) => {
      const { invocationId } = await enqueueInvocation(handle.db, {
        scope: 'audit-fence',
        prompt: 'audit',
      });
      const runId = '00000000-0000-4000-8000-000000000001';
      const claim = {
        invocationId,
        scope: 'audit-fence',
        runId,
        toolName: 'test',
        idempotencyKey: invocationId,
        requestSnapshot: { a: 1 },
        metadata: { toolCallId: 'first' },
        dispatchId: 'first',
      };
      const id = await claimToolCallAudit(handle.db, claim);
      expect(
        await completeToolCallAudit(
          handle.db,
          id,
          'failed',
          'old-error',
          runId,
          'first',
        ),
      ).toBe(true);
      const nextRun = sameRun ? runId : '00000000-0000-4000-8000-000000000002';
      expect(
        await claimToolCallAudit(handle.db, {
          ...claim,
          runId: nextRun,
          dispatchId: 'second',
          metadata: { toolCallId: 'second' },
        }),
      ).toBe(id);
      const reclaimed = await handle.pool.query(
        'select status, completed_at, error_code, metadata from agent_runtime.tool_call_audits where id=$1',
        [id],
      );
      expect(reclaimed.rows[0]).toMatchObject({
        status: 'started',
        completed_at: null,
        error_code: null,
        metadata: { toolCallId: 'second' },
      });
      expect(
        await completeToolCallAudit(
          handle.db,
          id,
          'failed',
          'stale',
          runId,
          'first',
        ),
      ).toBe(false);
      expect(
        await completeToolCallAudit(
          handle.db,
          id,
          'succeeded',
          undefined,
          nextRun,
          'second',
        ),
      ).toBe(true);
      expect(
        await completeToolCallAudit(
          handle.db,
          id,
          'failed',
          'duplicate',
          nextRun,
          'second',
        ),
      ).toBe(false);
      expect(
        (
          await handle.pool.query(
            'select status, error_code, run_id from agent_runtime.tool_call_audits where id=$1',
            [id],
          )
        ).rows[0],
      ).toEqual({ status: 'succeeded', error_code: null, run_id: nextRun });
      await claimToolCallAudit(handle.db, {
        ...claim,
        runId: nextRun,
        dispatchId: 'third',
        metadata: { toolCallId: 'third' },
      });
      expect(
        (
          await handle.pool.query(
            'select status, completed_at, error_code, request_snapshot, metadata from agent_runtime.tool_call_audits where id=$1',
            [id],
          )
        ).rows[0],
      ).toEqual({
        status: 'started',
        completed_at: null,
        error_code: null,
        request_snapshot: { a: 1 },
        metadata: { toolCallId: 'third', dispatchId: 'third' },
      });
      await handle.pool.query(
        "update agent_runtime.invocations set status='cancelled' where id=$1",
        [invocationId],
      );
    },
  );

  it('serializes same-ordering-key invocations at claim time', async () => {
    const a1 = await enqueueInvocation(handle.db, {
      scope: 'scope-order',
      prompt: 'first',
      orderingKey: 'conv-1',
    });
    const a2 = await enqueueInvocation(handle.db, {
      scope: 'scope-order',
      prompt: 'second',
      orderingKey: 'conv-1',
    });
    const b = await enqueueInvocation(handle.db, {
      scope: 'scope-order',
      prompt: 'unrelated',
    });

    const { claimed } = await claimInvocations(handle.db, 'worker-1', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 25,
    });
    const claimedIds = claimed.map((row) => String(row.id));
    expect(claimedIds).toContain(a1.invocationId);
    expect(claimedIds).toContain(b.invocationId);
    expect(claimedIds).not.toContain(a2.invocationId);

    await markInvocationSucceeded(
      handle.db,
      Number(a1.invocationId),
      'worker-1',
      claimed.find((row) => String(row.id) === a1.invocationId)!.activeRunId!,
      { resultText: 'done' },
    );
    const { claimed: next } = await claimInvocations(handle.db, 'worker-1', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 25,
    });
    expect(next.map((row) => String(row.id))).toContain(a2.invocationId);
  });

  it('reclaims an invocation whose lease expired without completion', async () => {
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-crash',
      prompt: 'crashy',
    });
    const { claimed } = await claimInvocations(handle.db, 'worker-dead', {
      leaseTimeoutMs: 300,
      maxBatchSize: 1,
    });
    expect(claimed.map((row) => String(row.id))).toEqual([invocationId]);

    const { claimed: tooEarly } = await claimInvocations(
      handle.db,
      'worker-2',
      {
        leaseTimeoutMs: 30_000,
        maxBatchSize: 25,
      },
    );
    expect(tooEarly.map((row) => String(row.id))).not.toContain(invocationId);

    await sleep(600);
    const { claimed: reclaimed } = await claimInvocations(
      handle.db,
      'worker-2',
      {
        leaseTimeoutMs: 30_000,
        maxBatchSize: 25,
      },
    );
    const row = reclaimed.find((entry) => String(entry.id) === invocationId);
    expect(row).toBeDefined();
    expect(row?.attemptCount).toBe(2);
    expect(row?.claimedBy).toBe('worker-2');
  });

  it('checks heartbeat ownership', async () => {
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-heartbeat',
      prompt: 'beat',
    });
    const { claimed } = await claimInvocations(handle.db, 'worker-owner', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 25,
    });
    const id = Number(invocationId);
    const runId = claimed.find((row) => row.id === id)!.activeRunId!;
    await expect(
      heartbeatInvocation(handle.db, id, 'worker-intruder', runId, 30_000),
    ).resolves.toBe(false);
    await expect(
      heartbeatInvocation(handle.db, id, 'worker-owner', runId, 30_000),
    ).resolves.toBe(true);
    const row = await getInvocationRowById(handle.db, invocationId);
    expect(row?.status).toBe('running');
  });

  it('retries failures and marks the final failure terminal', async () => {
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-failure',
      prompt: 'fail',
      maxAttempts: 2,
    });
    const {
      claimed: [first],
    } = await claimInvocations(handle.db, 'failure-worker', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    expect(String(first!.id)).toBe(invocationId);
    const retry = await markInvocationFailed(
      handle.db,
      first!.id,
      'failure-worker',
      first!.activeRunId!,
      { code: 'test', message: 'retry' },
      0,
    );
    expect(retry?.status).toBe('pending');
    const {
      claimed: [last],
    } = await claimInvocations(handle.db, 'failure-worker', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    const failed = await markInvocationFailed(
      handle.db,
      last!.id,
      'failure-worker',
      last!.activeRunId!,
      { code: 'test', message: 'terminal' },
      0,
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.attemptCount).toBe(2);
    expect(failed?.claimedBy).toBeNull();
    expect(failed?.completedAt).not.toBeNull();
  });

  it('terminalizes an exhausted expired claim and unblocks its successor', async () => {
    const first = await enqueueInvocation(handle.db, {
      scope: 'scope-exhausted',
      prompt: 'last claim',
      orderingKey: 'key',
      maxAttempts: 1,
    });
    const next = await enqueueInvocation(handle.db, {
      scope: 'scope-exhausted',
      prompt: 'next',
      orderingKey: 'key',
    });
    await claimInvocations(handle.db, 'crashed', {
      leaseTimeoutMs: 40,
      maxBatchSize: 1,
    });
    await sleep(100);
    const { claimed } = await claimInvocations(handle.db, 'recovery', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    expect(
      (await getInvocationRowById(handle.db, first.invocationId))?.status,
    ).toBe('failed');
    expect(
      (await getInvocationRowById(handle.db, first.invocationId))?.attemptCount,
    ).toBe(1);
    expect(claimed.map((row) => String(row.id))).toEqual([next.invocationId]);
    await markInvocationSucceeded(
      handle.db,
      claimed[0]!.id,
      'recovery',
      claimed[0]!.activeRunId!,
      { resultText: 'done' },
    );
  });

  it('fences stale attempts even when the worker id is reused', async () => {
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-fencing',
      prompt: 'fenced',
    });
    const {
      claimed: [old],
    } = await claimInvocations(handle.db, 'reused', {
      leaseTimeoutMs: 40,
      maxBatchSize: 1,
    });
    await sleep(100);
    const {
      claimed: [fresh],
    } = await claimInvocations(handle.db, 'reused', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    expect(String(fresh!.id)).toBe(invocationId);
    expect(fresh!.activeRunId).not.toBe(old!.activeRunId);
    expect(
      await heartbeatInvocation(
        handle.db,
        old!.id,
        'reused',
        old!.activeRunId!,
        30_000,
      ),
    ).toBe(false);
    expect(
      await markInvocationSucceeded(
        handle.db,
        old!.id,
        'reused',
        old!.activeRunId!,
        { resultText: 'stale' },
      ),
    ).toBe(false);
    expect(
      await markInvocationFailed(
        handle.db,
        old!.id,
        'reused',
        old!.activeRunId!,
        { code: 'stale', message: 'stale' },
        0,
      ),
    ).toBeUndefined();
    expect(
      await markInvocationSucceeded(
        handle.db,
        fresh!.id,
        'reused',
        fresh!.activeRunId!,
        { resultText: 'fresh' },
      ),
    ).toBe(true);
  });

  it('runs the worker lease singleton primitive', async () => {
    await expect(
      tryAcquireWorkerLease(handle.db, 'main-worker', 'holder-a', 30_000),
    ).resolves.toBe(true);
    await expect(
      tryAcquireWorkerLease(handle.db, 'main-worker', 'holder-b', 30_000),
    ).resolves.toBe(false);
    await expect(
      heartbeatWorkerLease(handle.db, 'main-worker', 'holder-b', 30_000),
    ).resolves.toBe(false);
    await expect(
      heartbeatWorkerLease(handle.db, 'main-worker', 'holder-a', 30_000),
    ).resolves.toBe(true);
    await releaseWorkerLease(handle.db, 'main-worker', 'holder-a');
    await expect(
      tryAcquireWorkerLease(handle.db, 'main-worker', 'holder-b', 30_000),
    ).resolves.toBe(true);
  });

  it.each(['approved', 'rejected'] as const)(
    'resolves concurrent approval/%s exactly once',
    async (other) => {
      const pending = {
        toolName: 'gated',
        input: { nested: { a: 1 }, values: [1, 2] },
      };
      const { invocationId } = await enqueueInvocation(handle.db, {
        scope: 'race',
        prompt: 'approve',
      });
      const {
        claimed: [row],
      } = await claimInvocations(handle.db, 'approval-worker', {
        leaseTimeoutMs: 30_000,
        maxBatchSize: 1,
      });
      expect(String(row!.id)).toBe(invocationId);
      await markInvocationAwaitingApproval(
        handle.db,
        row!.id,
        'approval-worker',
        row!.activeRunId!,
        { kind: 'tool', toolCall: pending },
      );
      const client = await handle.pool.connect();
      try {
        await client.query('begin');
        await client.query(
          'select id from agent_runtime.invocations where id=$1 for update',
          [invocationId],
        );
        const first = resolveInvocationApproval(
          handle.db,
          invocationId,
          'approved',
          { resolvedBy: 'reviewer', note: 'checked' },
        );
        const second = resolveInvocationApproval(
          handle.db,
          invocationId,
          other,
          { resolvedBy: 'reviewer', note: 'checked' },
        );
        expect(
          (
            await claimInvocations(handle.db, 'interleaved', {
              leaseTimeoutMs: 30_000,
              maxBatchSize: 1,
            })
          ).claimed,
        ).toEqual([]);
        expect(
          await heartbeatInvocation(
            handle.db,
            row!.id,
            'approval-worker',
            row!.activeRunId!,
            30_000,
          ),
        ).toBe(false);
        await client.query('commit');
        const results = await Promise.all([first, second]);
        expect(results.map((result) => result.outcome).sort()).toEqual([
          'not_awaiting',
          'resolved',
        ]);
        const audits = await handle.pool.query(
          'select decision, detail, tool_name from agent_runtime.policy_decisions where invocation_id=$1',
          [invocationId],
        );
        expect(audits.rows).toEqual([
          {
            decision:
              results.find((result) => result.outcome === 'resolved')!.row
                .status === 'cancelled'
                ? 'rejected'
                : 'approved',
            tool_name: 'gated',
            detail: {
              toolInput: pending.input,
              resolvedBy: 'reviewer',
              note: 'checked',
            },
          },
        ]);
        // Finish the surviving grant so subsequent claim tests stay isolated.
        const {
          claimed: [claimed],
        } = await claimInvocations(handle.db, 'cleanup', {
          leaseTimeoutMs: 30_000,
          maxBatchSize: 1,
        });
        if (claimed)
          await markInvocationSucceeded(
            handle.db,
            claimed.id,
            'cleanup',
            claimed.activeRunId!,
            { resultText: 'done' },
          );
      } finally {
        await client.query('rollback');
        client.release();
      }
    },
  );

  it('rolls back approval when its audit insert fails, then retains a grant only across retries', async () => {
    const pending = { toolName: 'gated', input: { amount: 5000 } };
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'approval-retry',
      prompt: 'approve',
      maxAttempts: 2,
      orderingKey: 'approval-order',
    });
    const {
      claimed: [row],
    } = await claimInvocations(handle.db, 'approval-retry', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    expect(String(row!.id)).toBe(invocationId);
    expect(
      await markInvocationAwaitingApproval(
        handle.db,
        row!.id,
        'wrong-worker',
        row!.activeRunId!,
        { kind: 'tool', toolCall: pending },
      ),
    ).toBeUndefined();
    expect(
      await markInvocationAwaitingApproval(
        handle.db,
        row!.id,
        'approval-retry',
        '00000000-0000-4000-8000-000000000000',
        { kind: 'tool', toolCall: pending },
      ),
    ).toBeUndefined();
    await markInvocationAwaitingApproval(
      handle.db,
      row!.id,
      'approval-retry',
      row!.activeRunId!,
      { kind: 'tool', toolCall: pending },
    );
    const follower = await enqueueInvocation(handle.db, {
      scope: 'approval-retry',
      prompt: 'next',
      orderingKey: 'approval-order',
    });
    expect(
      (
        await claimInvocations(handle.db, 'blocked', {
          leaseTimeoutMs: 30_000,
          maxBatchSize: 1,
        })
      ).claimed,
    ).toEqual([]);
    await handle.pool.query(
      `create function agent_runtime.fail_resolution() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$`,
    );
    await handle.pool.query(
      'create trigger fail_resolution before insert on agent_runtime.policy_decisions for each row execute function agent_runtime.fail_resolution()',
    );
    try {
      await expect(
        resolveInvocationApproval(handle.db, invocationId, 'approved'),
      ).rejects.toThrow();
      const parked = await getInvocationRowById(handle.db, invocationId);
      expect(parked?.status).toBe('awaiting_approval');
      expect(parked?.pendingToolCall).toEqual(pending);
      expect(
        (
          await handle.pool.query(
            'select * from agent_runtime.policy_decisions where invocation_id=$1',
            [invocationId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await handle.pool.query(
        'drop trigger fail_resolution on agent_runtime.policy_decisions',
      );
      await handle.pool.query('drop function agent_runtime.fail_resolution()');
    }
    await resolveInvocationApproval(handle.db, invocationId, 'approved');
    for (const status of ['pending', 'failed']) {
      const {
        claimed: [claimed],
      } = await claimInvocations(handle.db, 'approval-retry', {
        leaseTimeoutMs: 30_000,
        maxBatchSize: 1,
      });
      expect(claimed!.pendingToolCall).toEqual(pending);
      const failed = await markInvocationFailed(
        handle.db,
        claimed!.id,
        'approval-retry',
        claimed!.activeRunId!,
        { code: 'test', message: 'failed' },
        0,
      );
      expect(failed?.status).toBe(status);
      expect(failed?.pendingToolCall).toEqual(
        status === 'pending' ? pending : null,
      );
    }
    const {
      claimed: [next],
    } = await claimInvocations(handle.db, 'successor', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    expect(String(next!.id)).toBe(follower.invocationId);
    await markInvocationSucceeded(
      handle.db,
      next!.id,
      'successor',
      next!.activeRunId!,
      { resultText: 'done' },
    );
  });

  async function claimSpecific(invocationId: string, workerId: string) {
    // Earlier tests leave claimable rows behind; settle them so this test owns
    // its own freshly enqueued invocation.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const {
        claimed: [row],
      } = await claimInvocations(handle.db, workerId, {
        leaseTimeoutMs: 30_000,
        maxBatchSize: 1,
      });
      if (!row) throw new Error('no claim available');
      if (String(row.id) === invocationId) return row;
      await markInvocationFailed(
        handle.db,
        row.id,
        workerId,
        row.activeRunId!,
        { code: 'test_cleanup', message: 'test cleanup' },
        0,
        { retryable: false },
      );
    }
    throw new Error(`invocation ${invocationId} was never claimed`);
  }

  async function claimForPark(
    scope: string,
    workerId: string,
    prompt = 'park',
  ) {
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope,
      prompt,
    });
    return { invocationId, row: await claimSpecific(invocationId, workerId) };
  }

  async function parkBudget(scope: string, workerId: string, accumulated = 11) {
    const { invocationId, row } = await claimForPark(scope, workerId);
    const usage = budgetUsage(6, 5);
    const request = {
      requestId: row.activeRunId!,
      limits: budgetLimit(accumulated),
      usage,
    };
    const parked = await markInvocationAwaitingApproval(
      handle.db,
      row.id,
      workerId,
      row.activeRunId!,
      {
        kind: 'budget',
        request,
        detail: { effectiveLimits: { maxTokens: 10 } },
      },
    );
    expect(parked?.status).toBe('awaiting_approval');
    return { invocationId, row, request, usage };
  }

  it('parks a budget request with usage and its audit atomically', async () => {
    const { invocationId, row, request, usage } = await parkBudget(
      'budget-park',
      'budget-worker',
    );

    const parked = await getInvocationRowById(handle.db, invocationId);
    expect(parked).toMatchObject({
      status: 'awaiting_approval',
      attemptCount: 0,
      pendingToolCall: null,
      pendingBudgetRequest: request,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usageSteps: usage.steps,
    });
    expect(parked?.claimedBy).toBeNull();

    const audits = await handle.pool.query(
      `select rule, decision, run_id, tool_name, detail
         from agent_runtime.policy_decisions where invocation_id = $1`,
      [invocationId],
    );
    expect(audits.rows).toEqual([
      {
        rule: 'budget',
        decision: 'approval_requested',
        run_id: row.activeRunId,
        tool_name: null,
        detail: {
          event: 'approval_requested',
          requestId: row.activeRunId,
          limits: request.limits,
          usage,
          effectiveLimits: { maxTokens: 10 },
        },
      },
    ]);

    expect(
      await markInvocationAwaitingApproval(
        handle.db,
        row.id,
        'other-worker',
        row.activeRunId!,
        { kind: 'budget', request },
      ),
    ).toBeUndefined();
    expect(
      await markInvocationAwaitingApproval(
        handle.db,
        row.id,
        'budget-worker',
        '00000000-0000-4000-8000-000000000000',
        { kind: 'budget', request },
      ),
    ).toBeUndefined();
    expect(
      (await getInvocationRowById(handle.db, invocationId))
        ?.pendingBudgetRequest,
    ).toEqual(request);
  });

  it('rolls back a budget park when its audit insert fails', async () => {
    const { invocationId, row } = await claimForPark(
      'budget-park-audit',
      'budget-audit-worker',
    );
    const usage = budgetUsage(6, 5);
    const request = {
      requestId: row.activeRunId!,
      limits: budgetLimit(11),
      usage,
    };
    await handle.pool.query(
      `create function agent_runtime.reject_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$`,
    );
    await handle.pool.query(
      'create trigger reject_audit before insert on agent_runtime.policy_decisions for each row execute function agent_runtime.reject_audit()',
    );
    try {
      await expect(
        markInvocationAwaitingApproval(
          handle.db,
          row.id,
          'budget-audit-worker',
          row.activeRunId!,
          { kind: 'budget', request },
        ),
      ).rejects.toThrow();
    } finally {
      await handle.pool.query(
        'drop trigger reject_audit on agent_runtime.policy_decisions',
      );
      await handle.pool.query('drop function agent_runtime.reject_audit()');
    }
    const still = await getInvocationRowById(handle.db, invocationId);
    expect(still).toMatchObject({
      status: 'running',
      pendingBudgetRequest: null,
      inputTokens: null,
      claimedBy: 'budget-audit-worker',
    });
    expect(
      (
        await handle.pool.query(
          'select count(*)::int as count from agent_runtime.policy_decisions where invocation_id=$1',
          [invocationId],
        )
      ).rows[0].count,
    ).toBe(0);
    // Hand the claim back so the row cannot be reclaimed by a later test.
    await handle.pool.query(
      "update agent_runtime.invocations set status='cancelled' where id=$1",
      [invocationId],
    );
  });

  it('approves with a grant, accumulates across parks, and keeps the park snapshot', async () => {
    const configured = { maxTokens: 10 };
    const first = await parkBudget('budget-grant', 'grant-worker');
    const approved = await resolveInvocationApproval(
      handle.db,
      first.invocationId,
      'approved',
      {
        resolvedBy: 'admin',
        grant: { maxTokens: 5 },
        requestId: first.request.requestId,
      },
      configured,
    );
    expect(resolvedRow(approved)).toMatchObject({
      status: 'pending',
      pendingBudgetRequest: null,
      budgetGrants: { maxTokens: 5 },
    });

    const second = await claimSpecific(first.invocationId, 'grant-worker');
    expect(second.budgetGrants).toEqual({ maxTokens: 5 });
    expect(second.activeRunId).not.toBe(first.row.activeRunId);

    const usage = budgetUsage(9, 6);
    const request = {
      requestId: second!.activeRunId!,
      limits: budgetLimit(21, 20),
      usage,
    };
    const parkedSecond = await markInvocationAwaitingApproval(
      handle.db,
      second!.id,
      'grant-worker',
      second!.activeRunId!,
      { kind: 'budget', request },
    );
    expect(parkedSecond?.status).toBe('awaiting_approval');
    const approvedAgain = await resolveInvocationApproval(
      handle.db,
      String(second!.id),
      'approved',
      { grant: { maxTokens: 5 }, requestId: request.requestId },
      configured,
    );
    expect(resolvedRow(approvedAgain).budgetGrants).toEqual({ maxTokens: 10 });

    const audits = await handle.pool.query<{
      decision: string;
      detail: unknown;
    }>(
      `select decision, detail from agent_runtime.policy_decisions
        where invocation_id = $1 and rule = 'budget' order by id`,
      [first.invocationId],
    );
    expect(audits.rows.map((row) => row.decision)).toEqual([
      'approval_requested',
      'approved',
      'approval_requested',
      'approved',
    ]);
    expect(
      audits.rows.filter((row) => row.decision === 'approval_requested')[0]
        ?.detail,
    ).toMatchObject({ requestId: first.row.activeRunId, usage: first.usage });
    expect(
      audits.rows.filter((row) => row.decision === 'approved')[1]?.detail,
    ).toMatchObject({
      grants: { maxTokens: 10 },
      effectiveLimits: { maxTokens: 20 },
    });

    // A later run's usage replaces the columns; the park audit keeps the snapshot.
    const third = await claimSpecific(first.invocationId, 'grant-worker');
    const resumed = budgetUsage(2, 3);
    await markInvocationSucceeded(
      handle.db,
      third.id,
      'grant-worker',
      third.activeRunId!,
      { resultText: 'done', usage: resumed },
    );
    const finished = await getInvocationRowById(handle.db, first.invocationId);
    expect(finished).toMatchObject({
      status: 'succeeded',
      inputTokens: 2,
      outputTokens: 3,
      pendingBudgetRequest: null,
    });
    expect(
      (
        await handle.pool.query(
          `select detail from agent_runtime.policy_decisions
            where invocation_id = $1 and decision = 'approval_requested' order by id`,
          [first.invocationId],
        )
      ).rows.map((row) => row.detail.usage),
    ).toEqual([first.usage, usage]);
  });

  it('rejects a stale request identity without touching the newer park', async () => {
    const configured = { maxTokens: 10 };
    const { invocationId, request } = await parkBudget(
      'budget-stale',
      'stale-worker',
    );

    await expect(
      resolveInvocationApproval(
        handle.db,
        invocationId,
        'approved',
        { grant: { maxTokens: 5 } },
        configured,
      ),
    ).resolves.toMatchObject({ outcome: 'stale_request' });
    await expect(
      resolveInvocationApproval(
        handle.db,
        invocationId,
        'rejected',
        { requestId: '00000000-0000-4000-8000-000000000000' },
        configured,
      ),
    ).resolves.toMatchObject({ outcome: 'stale_request' });

    const parked = await getInvocationRowById(handle.db, invocationId);
    expect(parked).toMatchObject({
      status: 'awaiting_approval',
      pendingBudgetRequest: request,
      budgetGrants: null,
    });
    expect(
      (
        await handle.pool.query(
          'select count(*)::int as count from agent_runtime.policy_decisions where invocation_id=$1',
          [invocationId],
        )
      ).rows[0].count,
    ).toBe(1);

    await expect(
      resolveInvocationApproval(
        handle.db,
        invocationId,
        'approved',
        { grant: { maxTokens: 5 }, requestId: request.requestId },
        configured,
      ),
    ).resolves.toMatchObject({ outcome: 'resolved' });
  });

  it('rejects invalid grants without changing state', async () => {
    const configured = { maxTokens: 10 };
    const { invocationId, request } = await parkBudget(
      'budget-invalid-grant',
      'invalid-grant-worker',
    );
    for (const grant of [
      {},
      { maxTokens: 0 },
      { maxTokens: 1.5 },
      { maxCostUsd: 1 },
    ]) {
      await expect(
        resolveInvocationApproval(
          handle.db,
          invocationId,
          'approved',
          { grant, requestId: request.requestId },
          configured,
        ),
      ).rejects.toMatchObject({
        diagnostics: { code: 'invalid_budget_grant' },
      });
    }
    const parked = await getInvocationRowById(handle.db, invocationId);
    expect(parked?.status).toBe('awaiting_approval');
    expect(parked?.budgetGrants).toBeNull();
    expect(
      (
        await handle.pool.query(
          'select count(*)::int as count from agent_runtime.policy_decisions where invocation_id=$1',
          [invocationId],
        )
      ).rows[0].count,
    ).toBe(1);
    await resolveInvocationApproval(
      handle.db,
      invocationId,
      'rejected',
      { requestId: request.requestId },
      configured,
    );
  });

  it('rejects a grant on a tool approval', async () => {
    const { invocationId, row } = await claimForPark(
      'tool-grant-rejected',
      'tool-grant-worker',
    );
    const toolCall = { toolName: 'gated', input: { amount: 5000 } };
    await markInvocationAwaitingApproval(
      handle.db,
      row.id,
      'tool-grant-worker',
      row.activeRunId!,
      { kind: 'tool', toolCall },
    );

    await expect(
      resolveInvocationApproval(
        handle.db,
        invocationId,
        'approved',
        { grant: { maxTokens: 5 } },
        { maxTokens: 10 },
      ),
    ).rejects.toMatchObject({ diagnostics: { code: 'invalid_budget_grant' } });
    const parked = await getInvocationRowById(handle.db, invocationId);
    expect(parked).toMatchObject({
      status: 'awaiting_approval',
      pendingToolCall: toolCall,
    });
    await resolveInvocationApproval(handle.db, invocationId, 'approved');
  });

  it('rejects a budget park as a non-retryable budget failure with usage kept', async () => {
    const configured = { maxTokens: 10 };
    const { invocationId, request } = await parkBudget(
      'budget-reject',
      'reject-worker',
    );
    const rejected = await resolveInvocationApproval(
      handle.db,
      invocationId,
      'rejected',
      { requestId: request.requestId, note: 'quota denied' },
      configured,
    );
    expect(resolvedRow(rejected)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'budget_exceeded',
      lastErrorMessage: 'quota denied',
      budgetGrants: null,
      pendingBudgetRequest: null,
      inputTokens: 6,
      outputTokens: 5,
    });
    const audits = await handle.pool.query(
      `select decision, detail from agent_runtime.policy_decisions
        where invocation_id = $1 and rule = 'budget' order by id`,
      [invocationId],
    );
    expect(audits.rows.map((row) => row.decision)).toEqual([
      'approval_requested',
      'rejected',
    ]);
    expect(audits.rows[1]?.detail).toMatchObject({
      requestId: request.requestId,
      effectiveLimits: { maxTokens: 10 },
      note: 'quota denied',
    });
    await expect(
      resolveInvocationApproval(
        handle.db,
        invocationId,
        'approved',
        { grant: { maxTokens: 5 }, requestId: request.requestId },
        configured,
      ),
    ).resolves.toMatchObject({ outcome: 'not_awaiting' });
  });

  it('applies exactly one concurrent budget resolution', async () => {
    const configured = { maxTokens: 10 };
    const { invocationId, request } = await parkBudget(
      'budget-race',
      'race-budget-worker',
    );
    const results = await Promise.all([
      resolveInvocationApproval(
        handle.db,
        invocationId,
        'approved',
        { grant: { maxTokens: 5 }, requestId: request.requestId },
        configured,
      ),
      resolveInvocationApproval(
        handle.db,
        invocationId,
        'rejected',
        { requestId: request.requestId },
        configured,
      ),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'not_awaiting',
      'resolved',
    ]);
    const row = await getInvocationRowById(handle.db, invocationId);
    expect(['pending', 'failed']).toContain(row?.status);
    expect(
      (
        await handle.pool.query(
          `select decision from agent_runtime.policy_decisions
            where invocation_id = $1 and rule = 'budget' order by id`,
          [invocationId],
        )
      ).rows.map((entry) => entry.decision),
    ).toEqual([
      'approval_requested',
      row?.status === 'pending' ? 'approved' : 'rejected',
    ]);
    if (row?.status === 'pending') {
      const claimed = await claimSpecific(invocationId, 'race-budget-worker');
      await markInvocationSucceeded(
        handle.db,
        claimed.id,
        'race-budget-worker',
        claimed.activeRunId!,
        { resultText: 'done' },
      );
    }
  });
});
