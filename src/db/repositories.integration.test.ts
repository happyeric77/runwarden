import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DatabaseHandle } from './client';
import { initDb } from './init';
import {
  claimInvocations,
  enqueueInvocation,
  getInvocationRowById,
  heartbeatInvocation,
  markInvocationSucceeded,
} from './repositories/invocations';
import {
  heartbeatWorkerLease,
  releaseWorkerLease,
  tryAcquireWorkerLease,
} from './repositories/leases';
import { startTestPostgres, type TestPostgres } from './test-postgres';

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

    const claimed = await claimInvocations(handle.db, 'worker-1', {
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
      { resultText: 'done' },
    );
    const next = await claimInvocations(handle.db, 'worker-1', {
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
    const claimed = await claimInvocations(handle.db, 'worker-dead', {
      leaseTimeoutMs: 300,
      maxBatchSize: 1,
    });
    expect(claimed.map((row) => String(row.id))).toEqual([invocationId]);

    const tooEarly = await claimInvocations(handle.db, 'worker-2', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 25,
    });
    expect(tooEarly.map((row) => String(row.id))).not.toContain(invocationId);

    await sleep(600);
    const reclaimed = await claimInvocations(handle.db, 'worker-2', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 25,
    });
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
    await claimInvocations(handle.db, 'worker-owner', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 25,
    });
    const id = Number(invocationId);
    await expect(
      heartbeatInvocation(handle.db, id, 'worker-intruder', 30_000),
    ).resolves.toBe(false);
    await expect(
      heartbeatInvocation(handle.db, id, 'worker-owner', 30_000),
    ).resolves.toBe(true);
    const row = await getInvocationRowById(handle.db, invocationId);
    expect(row?.status).toBe('running');
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
});
