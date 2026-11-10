import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DatabaseHandle } from './client.js';
import { initDb } from './init.js';
import { resolveInvocationApproval } from './repositories/approvals.js';
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
        pending,
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
        pending,
      ),
    ).toBeUndefined();
    expect(
      await markInvocationAwaitingApproval(
        handle.db,
        row!.id,
        'approval-retry',
        '00000000-0000-4000-8000-000000000000',
        pending,
      ),
    ).toBeUndefined();
    await markInvocationAwaitingApproval(
      handle.db,
      row!.id,
      'approval-retry',
      row!.activeRunId!,
      pending,
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
});
