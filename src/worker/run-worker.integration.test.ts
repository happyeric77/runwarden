import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentRuntimeError } from '../contracts/errors';
import type { PolicyDecision } from '../contracts/policy';
import type { McpToolClient } from '../contracts/runtime';
import { createDb, type DatabaseHandle } from '../db/client';
import { initDb } from '../db/init';
import {
  claimInvocations,
  enqueueInvocation,
  getInvocationRowById,
} from '../db/repositories/invocations';
import {
  startTestPostgres,
  waitFor,
  type TestPostgres,
} from '../db/test-postgres';
import { defineRuntime, RUNTIME_INTERNALS } from '../define-runtime';
import { FakeAgentRuntime } from '../fake-runtime';
import { runWorker } from './run-worker';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runWorker', () => {
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

  it('completes an enqueued invocation end to end', async () => {
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-e2e',
      prompt: 'hello worker',
    });
    const worker = runWorker({
      runtime: { engine: new FakeAgentRuntime() },
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, invocationId);
        return row?.status === 'succeeded';
      });
      const row = await getInvocationRowById(handle.db, invocationId);
      expect(row?.resultText).toBe('Fake runtime response to: hello worker');
      expect(row?.attemptCount).toBe(1);
      expect(row?.activeRunId).toBeTruthy();
    } finally {
      await worker.stop();
    }
  });

  it('recovers an invocation claimed by a worker that died', async () => {
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-recovery',
      prompt: 'survive a crash',
    });
    const claimed = await claimInvocations(handle.db, 'worker-crashed', {
      leaseTimeoutMs: 400,
      maxBatchSize: 1,
    });
    expect(claimed.map((row) => String(row.id))).toEqual([invocationId]);

    await sleep(700);
    const worker = runWorker({
      runtime: { engine: new FakeAgentRuntime() },
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, invocationId);
        return row?.status === 'succeeded';
      });
      const row = await getInvocationRowById(handle.db, invocationId);
      expect(row?.attemptCount).toBe(2);
      expect(row?.claimedBy).toBeNull();
    } finally {
      await worker.stop();
    }
  });

  it('executes same-ordering-key invocations serially, in order', async () => {
    const events: string[] = [];
    const engine = {
      async invoke(input: { prompt: string; invocationId: string }) {
        events.push(`start:${input.prompt}`);
        await sleep(80);
        events.push(`end:${input.prompt}`);
        return {
          invocationId: input.invocationId,
          runId: 'run',
          text: `done ${input.prompt}`,
        };
      },
    };
    const first = await enqueueInvocation(handle.db, {
      scope: 'scope-serial',
      prompt: 'one',
      orderingKey: 'conv-9',
    });
    const second = await enqueueInvocation(handle.db, {
      scope: 'scope-serial',
      prompt: 'two',
      orderingKey: 'conv-9',
    });
    const workers = [0, 1].map(() =>
      runWorker({
        runtime: { engine },
        db: handle,
        pollIdleMs: 50,
        pollActiveMs: 10,
      }),
    );
    try {
      await waitFor(async () => {
        const a = await getInvocationRowById(handle.db, first.invocationId);
        const b = await getInvocationRowById(handle.db, second.invocationId);
        return a?.status === 'succeeded' && b?.status === 'succeeded';
      });
      expect(events).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  });

  it('does not preclaim work that can expire while another invocation executes', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await enqueueInvocation(handle.db, {
      scope: 'scope-batch',
      prompt: 'first',
    });
    const second = await enqueueInvocation(handle.db, {
      scope: 'scope-batch',
      prompt: 'second',
    });
    const a = runWorker({
      db: handle,
      workerId: 'batch-a',
      leaseTimeoutMs: 150,
      heartbeatIntervalMs: 20,
      pollIdleMs: 10,
      pollActiveMs: 10,
      runtime: {
        engine: {
          async invoke(input) {
            events.push(`a:${input.prompt}`);
            if (input.prompt === 'first') await gate;
            return {
              invocationId: input.invocationId,
              runId: input.runId,
              text: 'a',
            };
          },
        },
      },
    });
    await waitFor(async () => events.length === 1);
    await sleep(250);
    const b = runWorker({
      db: handle,
      workerId: 'batch-b',
      leaseTimeoutMs: 150,
      heartbeatIntervalMs: 20,
      pollIdleMs: 10,
      pollActiveMs: 10,
      runtime: {
        engine: {
          async invoke(input) {
            events.push(`b:${input.prompt}`);
            return {
              invocationId: input.invocationId,
              runId: input.runId,
              text: 'b',
            };
          },
        },
      },
    });
    try {
      await waitFor(
        async () =>
          (await getInvocationRowById(handle.db, second.invocationId))
            ?.status === 'succeeded',
      );
      release();
      await waitFor(
        async () =>
          (await getInvocationRowById(handle.db, first.invocationId))
            ?.status === 'succeeded',
      );
    } finally {
      release();
      await Promise.all([a.stop(), b.stop()]);
    }
    expect(events).toEqual(['a:first', 'b:second']);
    expect(
      (await getInvocationRowById(handle.db, second.invocationId))
        ?.attemptCount,
    ).toBe(1);
  });

  it('retries execution failures without stopping the worker', async () => {
    let calls = 0;
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-retry-worker',
      prompt: 'retry',
      maxAttempts: 2,
    });
    const worker = runWorker({
      db: handle,
      retryDelayMs: 0,
      pollIdleMs: 10,
      pollActiveMs: 10,
      runtime: {
        engine: {
          async invoke(input) {
            if (++calls === 1) throw new Error('retry me');
            return {
              invocationId: input.invocationId,
              runId: input.runId,
              text: 'retried',
            };
          },
        },
      },
    });
    try {
      await waitFor(
        async () =>
          (await getInvocationRowById(handle.db, invocationId))?.status ===
          'succeeded',
      );
    } finally {
      await worker.stop();
    }
    expect(calls).toBe(2);
  });

  it('waits for audit persistence before success and stop', async () => {
    await handle.pool.query(
      `create function agent_runtime.delay_audit() returns trigger language plpgsql as $$ begin perform pg_sleep(0.3); return NEW; end $$`,
    );
    await handle.pool.query(
      'create trigger delay_audit before insert on agent_runtime.policy_decisions for each row execute function agent_runtime.delay_audit()',
    );
    let listener: ((decision: PolicyDecision) => void) | undefined;
    let invoked = false;
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-audit-stop',
      prompt: 'audit',
    });
    const worker = runWorker({
      db: handle,
      pollIdleMs: 10,
      pollActiveMs: 10,
      runtime: {
        [RUNTIME_INTERNALS]: {
          onPolicyDecision(callback) {
            listener = callback;
            return () => {
              listener = undefined;
            };
          },
        },
        engine: {
          async invoke(input) {
            listener?.({ ...input, rule: 'allowlist', decision: 'deny' });
            invoked = true;
            return {
              invocationId: input.invocationId,
              runId: input.runId,
              text: 'audited',
            };
          },
        },
      },
    });
    try {
      await waitFor(async () => invoked);
      await worker.stop();
      const result = await handle.pool.query(
        'select count(*)::int as count from agent_runtime.policy_decisions where invocation_id=$1',
        [invocationId],
      );
      expect(result.rows[0].count).toBe(1);
      expect(
        (await getInvocationRowById(handle.db, invocationId))?.status,
      ).toBe('succeeded');
    } finally {
      await worker.stop();
      await handle.pool.query(
        'drop trigger delay_audit on agent_runtime.policy_decisions',
      );
      await handle.pool.query('drop function agent_runtime.delay_audit()');
    }
  });

  it.each([false, true])(
    'audit failure wins over completion or approval parking: %s',
    async (approval) => {
      await handle.pool.query(
        `create function agent_runtime.reject_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$`,
      );
      await handle.pool.query(
        'create trigger reject_audit before insert on agent_runtime.policy_decisions for each row execute function agent_runtime.reject_audit()',
      );
      let listener: ((decision: PolicyDecision) => void) | undefined;
      const { invocationId } = await enqueueInvocation(handle.db, {
        scope: 'scope-audit-error',
        prompt: 'audit',
        maxAttempts: 1,
      });
      const worker = runWorker({
        db: handle,
        pollIdleMs: 10,
        pollActiveMs: 10,
        runtime: {
          [RUNTIME_INTERNALS]: {
            onPolicyDecision(callback) {
              listener = callback;
              return () => {
                listener = undefined;
              };
            },
          },
          engine: {
            async invoke(input) {
              listener?.({ ...input, rule: 'allowlist', decision: 'deny' });
              if (approval)
                throw new AgentRuntimeError('failure', 'Approval required', {
                  code: 'approval_required',
                  pendingToolCall: { toolName: 'gated', input: {} },
                });
              return {
                invocationId: input.invocationId,
                runId: input.runId,
                text: 'not committed',
              };
            },
          },
        },
      });
      try {
        await waitFor(
          async () =>
            (await getInvocationRowById(handle.db, invocationId))?.status ===
            'failed',
        );
        const row = await getInvocationRowById(handle.db, invocationId);
        expect(row?.lastErrorCode).toBe('audit_persistence_failed');
        expect(row?.resultText).toBeNull();
      } finally {
        await worker.stop();
        await handle.pool.query(
          'drop trigger reject_audit on agent_runtime.policy_decisions',
        );
        await handle.pool.query('drop function agent_runtime.reject_audit()');
      }
    },
  );

  it('discards a late result after heartbeat reports lost ownership', async () => {
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-lost',
      prompt: 'lost',
    });
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = runWorker({
      db: handle,
      workerId: 'lost-a',
      heartbeatIntervalMs: 10,
      pollIdleMs: 10,
      pollActiveMs: 10,
      runtime: {
        engine: {
          async invoke(input) {
            entered = true;
            await gate;
            return {
              invocationId: input.invocationId,
              runId: input.runId,
              text: 'late',
            };
          },
        },
      },
    });
    try {
      await waitFor(async () => entered);
      await handle.pool.query(
        "update agent_runtime.invocations set claimed_by='lost-b' where id=$1",
        [invocationId],
      );
      await sleep(60);
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await sleep(20);
      expect(stopped).toBe(false);
      release();
      await stopping;
      const row = await getInvocationRowById(handle.db, invocationId);
      expect(row?.claimedBy).toBe('lost-b');
      expect(row?.status).toBe('running');
      expect(row?.resultText).toBeNull();
    } finally {
      release();
      await worker.stop();
    }
  });
});

describe('durable defineRuntime', () => {
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

  it('invoke() enqueues, a worker executes, and policy decisions persist', async () => {
    let executedTools = 0;
    const fakeMcpClient: McpToolClient = {
      async open() {
        return {
          async callTool() {
            executedTools++;
            return JSON.stringify([
              { type: 'text', text: 'Note found: "Roadmap": ship it.' },
            ]);
          },
          async close() {},
        };
      },
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        const finish = (content: unknown[]) => ({
          content: content as never,
          finishReason: { unified: 'stop', raw: 'stop' } as const,
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        });
        if (promptText.includes('Note found')) {
          return finish([{ type: 'text', text: 'The note says ship it.' }]);
        }
        if (promptText.includes('execution-denied')) {
          return finish([
            {
              type: 'tool-call',
              toolCallId: 'call-2',
              toolName: 'notes__lookup_note',
              input: JSON.stringify({ query: 'roadmap' }),
            },
          ]);
        }
        return finish([
          {
            type: 'tool-call',
            toolCallId: 'call-1a',
            toolName: 'notes__lookup_note',
            input: JSON.stringify({ query: 'roadmap' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'call-1b',
            toolName: 'notes__lookup_note',
            input: JSON.stringify({ query: 'budget' }),
          },
        ]);
      },
    });

    const runtime = defineRuntime({
      db: handle,
      model,
      onPolicyDecision: () => {
        throw new Error('observer failed');
      },
      mcpClient: fakeMcpClient,
      tools: [
        {
          name: 'notes__lookup_note',
          description: 'Look up a note by its title keyword.',
          inputSchema: z.object({ query: z.string().min(1) }),
        },
      ],
      loadSystemPrompt: async () => 'You are a helpful notes assistant.',
      loadHistory: async () => [],
    });

    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const enqueued = await runtime.enqueue({
        scope: 'scope-durable',
        prompt: 'queued first',
        idempotencyKey: 'durable-1',
      });
      const enqueuedAgain = await runtime.enqueue({
        scope: 'scope-durable',
        prompt: 'queued first',
        idempotencyKey: 'durable-1',
      });
      expect(enqueuedAgain.invocationId).toBe(enqueued.invocationId);

      const result = await runtime.invoke(
        { scope: 'scope-durable', prompt: 'What does my roadmap note say?' },
        { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
      );
      expect(result.text).toBe('The note says ship it.');

      const record = await runtime.getInvocation(result.invocationId);
      expect(record?.status).toBe('succeeded');
      expect(record?.resultText).toBe('The note says ship it.');

      const decisions = await handle.pool.query<{
        rule: string;
        decision: string;
      }>(
        `select rule, decision from agent_runtime.policy_decisions
         where invocation_id = $1 order by id`,
        [result.invocationId],
      );
      expect(decisions.rows.length).toBe(3);
      expect(executedTools).toBe(2);
      expect(
        decisions.rows.some(
          (row) => row.rule === 'exactly_one' && row.decision === 'deny',
        ),
      ).toBe(true);
      expect(
        decisions.rows.some((row) => row.decision === 'correction_issued'),
      ).toBe(true);
    } finally {
      await worker.stop();
    }
  });
});

describe('approval state machine', () => {
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

  function setup() {
    let executedTools = 0;
    let amountCents = 5000;
    const fakeMcpClient: McpToolClient = {
      async open() {
        return {
          async callTool() {
            executedTools++;
            return JSON.stringify([
              { type: 'text', text: 'Refund issued for order 42.' },
            ]);
          },
          async close() {},
        };
      },
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        const finish = (content: unknown[]) => ({
          content: content as never,
          finishReason: { unified: 'stop', raw: 'stop' } as const,
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        });
        if (promptText.includes('Refund issued')) {
          return finish([{ type: 'text', text: 'Refund completed.' }]);
        }
        return finish([
          {
            type: 'tool-call',
            toolCallId: 'call-refund',
            toolName: 'billing__refund',
            input: JSON.stringify({
              amountCents,
              reason: 'duplicate charge',
            }),
          },
        ]);
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: fakeMcpClient,
      tools: [
        {
          name: 'billing__refund',
          description: 'Refund a charge to the original payment method.',
          inputSchema: z.object({
            amountCents: z.number().int().positive(),
            reason: z.string().min(1),
          }),
        },
      ],
      loadSystemPrompt: async () => 'You are a helpful billing assistant.',
      loadHistory: async () => [],
      policies: { requireApproval: ['billing__refund'] },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    return {
      runtime,
      worker,
      executed: () => executedTools,
      setAmount: (amount: number) => {
        amountCents = amount;
      },
    };
  }

  async function decisionsFor(invocationId: string) {
    const result = await handle.pool.query<{ decision: string }>(
      `select decision from agent_runtime.policy_decisions
        where invocation_id = $1 and rule = 'require_approval' order by id`,
      [invocationId],
    );
    return result.rows.map((row) => row.decision);
  }

  it('parks a gated call, then an approval reruns it to completion', async () => {
    const { runtime, worker, executed } = setup();
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'scope-approval',
        prompt: 'Refund order 42: 5000 cents, duplicate charge.',
        maxAttempts: 1,
      });
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, invocationId);
        return row?.status === 'awaiting_approval';
      });
      const parked = await getInvocationRowById(handle.db, invocationId);
      expect(parked?.pendingToolCall).toEqual({
        toolName: 'billing__refund',
        input: { amountCents: 5000, reason: 'duplicate charge' },
      });
      expect(parked?.attemptCount).toBe(0);
      expect(executed()).toBe(0);

      const pending = await runtime.listPendingApprovals('scope-approval');
      expect(pending.map((record) => record.id)).toEqual([invocationId]);
      expect(pending[0]?.pendingToolCall?.toolName).toBe('billing__refund');

      const approved = await runtime.approveInvocation(invocationId, {
        resolvedBy: 'admin-1',
      });
      expect(approved.status).toBe('pending');

      const result = await runtime.waitForInvocation(invocationId, {
        pollIntervalMs: 50,
        waitTimeoutMs: 30_000,
      });
      expect(result.text).toBe('Refund completed.');
      expect(executed()).toBe(1);
      const done = await getInvocationRowById(handle.db, invocationId);
      expect(done?.status).toBe('succeeded');
      expect(done?.attemptCount).toBe(1);
      expect(done?.pendingToolCall).toBeNull();
      expect(await decisionsFor(invocationId)).toEqual([
        'approval_requested',
        'approved',
        'allow',
      ]);
    } finally {
      await worker.stop();
    }
  });

  it('parks changed arguments again without executing or consuming an attempt', async () => {
    const { runtime, worker, executed, setAmount } = setup();
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'changed-approval',
        prompt: 'Refund',
        maxAttempts: 1,
      });
      await waitFor(
        async () =>
          (await runtime.getInvocation(invocationId))?.status ===
          'awaiting_approval',
      );
      setAmount(6000);
      await runtime.approveInvocation(invocationId);
      await expect(
        runtime.waitForInvocation(invocationId, { pollIntervalMs: 20 }),
      ).rejects.toMatchObject({ diagnostics: { code: 'approval_required' } });
      const parked = await getInvocationRowById(handle.db, invocationId);
      expect(parked?.pendingToolCall).toEqual({
        toolName: 'billing__refund',
        input: { amountCents: 6000, reason: 'duplicate charge' },
      });
      expect(parked?.attemptCount).toBe(0);
      expect(executed()).toBe(0);
      await runtime.approveInvocation(invocationId);
      await expect(
        runtime.waitForInvocation(invocationId, { pollIntervalMs: 20 }),
      ).resolves.toMatchObject({ text: 'Refund completed.' });
      expect(executed()).toBe(1);
      expect(await decisionsFor(invocationId)).toEqual([
        'approval_requested',
        'approved',
        'approval_requested',
        'approved',
        'allow',
      ]);
    } finally {
      await worker.stop();
    }
  });

  it('reject cancels the invocation and later resolutions fail', async () => {
    const { runtime, worker, executed } = setup();
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'scope-approval',
        prompt: 'Refund order 42: 5000 cents, duplicate charge.',
        maxAttempts: 1,
      });
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, invocationId);
        return row?.status === 'awaiting_approval';
      });
      const rejected = await runtime.rejectInvocation(invocationId, {
        resolvedBy: 'admin-2',
        note: 'Already refunded through another channel',
      });
      expect(rejected.status).toBe('cancelled');
      expect(rejected.lastErrorCode).toBe('approval_rejected');
      expect(executed()).toBe(0);
      expect(await decisionsFor(invocationId)).toEqual([
        'approval_requested',
        'rejected',
      ]);
      await expect(
        runtime.approveInvocation(invocationId),
      ).rejects.toMatchObject({
        diagnostics: { code: 'invocation_not_awaiting_approval' },
      });
    } finally {
      await worker.stop();
    }
  });

  it('invoke() surfaces approval_required once the invocation parks', async () => {
    const { runtime, worker } = setup();
    try {
      await expect(
        runtime.invoke(
          {
            scope: 'scope-approval',
            prompt: 'Refund order 42: 5000 cents, duplicate charge.',
            maxAttempts: 1,
          },
          { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
        ),
      ).rejects.toMatchObject({
        diagnostics: { code: 'approval_required' },
      });
      const pending = await runtime.listPendingApprovals('scope-approval');
      expect(pending).toHaveLength(1);
      await runtime.rejectInvocation(pending[0]!.id);
    } finally {
      await worker.stop();
    }
  });

  it('filters an empty scope without exposing other pending approvals', async () => {
    const { runtime, worker } = setup();
    try {
      const ids: string[] = [];
      for (const scope of ['', 'other']) {
        const { invocationId } = await runtime.enqueue({
          scope,
          prompt: 'Refund',
          maxAttempts: 1,
        });
        ids.push(invocationId);
        await waitFor(
          async () =>
            (await runtime.getInvocation(invocationId))?.status ===
            'awaiting_approval',
        );
      }
      expect(
        (await runtime.listPendingApprovals('')).map((row) => row.id),
      ).toEqual([ids[0]]);
      for (const id of ids) await runtime.rejectInvocation(id);
    } finally {
      await worker.stop();
    }
  });
});

describe('tool call audits', () => {
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

  function setup() {
    const executed = { search: 0, refund: 0 };
    let failNextSearch = false;
    const fakeMcpClient: McpToolClient = {
      async open() {
        return {
          async callTool(call) {
            if (call.name === 'notes__search') {
              if (failNextSearch) {
                failNextSearch = false;
                throw new Error('mcp down');
              }
              executed.search++;
              return JSON.stringify([
                { type: 'text', text: 'The roadmap note says ship it.' },
              ]);
            }
            executed.refund++;
            return JSON.stringify([
              { type: 'text', text: 'Refund issued for order 42.' },
            ]);
          },
          async close() {},
        };
      },
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        const finish = (content: unknown[]) => ({
          content: content as never,
          finishReason: { unified: 'stop', raw: 'stop' } as const,
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        });
        if (promptText.includes('Refund issued')) {
          return finish([{ type: 'text', text: 'Refund completed.' }]);
        }
        if (promptText.includes('roadmap note says')) {
          return finish([{ type: 'text', text: 'Found the note.' }]);
        }
        if (promptText.includes('Refund order')) {
          return finish([
            {
              type: 'tool-call',
              toolCallId: 'call-refund',
              toolName: 'billing__refund',
              input: JSON.stringify({
                amountCents: 5000,
                reason: 'duplicate charge',
              }),
            },
          ]);
        }
        return finish([
          {
            type: 'tool-call',
            toolCallId: 'call-search',
            toolName: 'notes__search',
            input: JSON.stringify({ query: 'roadmap' }),
          },
        ]);
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: fakeMcpClient,
      tools: [
        {
          name: 'notes__search',
          description: 'Search the notes store by query text.',
          inputSchema: z.object({ query: z.string().min(1) }),
        },
        {
          name: 'billing__refund',
          description: 'Refund a charge to the original payment method.',
          inputSchema: z.object({
            amountCents: z.number().int().positive(),
            reason: z.string().min(1),
          }),
        },
      ],
      loadSystemPrompt: async () => 'You are a helpful assistant.',
      loadHistory: async () => [],
      policies: { requireApproval: ['billing__refund'] },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
      retryDelayMs: 5_000,
    });
    return {
      runtime,
      worker,
      executed,
      failNextSearch: () => {
        failNextSearch = true;
      },
    };
  }

  interface AuditRow {
    id: number;
    tool_name: string;
    status: string;
    idempotency_key: string;
    error_code: string | null;
    run_id: string;
    scope: string;
    request_snapshot: unknown;
    completed_at: Date | null;
  }

  async function auditsFor(invocationId: string): Promise<AuditRow[]> {
    const result = await handle.pool.query<AuditRow>(
      `select id, tool_name, status, idempotency_key, error_code,
              run_id::text as run_id, scope, request_snapshot, completed_at
         from agent_runtime.tool_call_audits
        where invocation_id = $1 order by id`,
      [invocationId],
    );
    return result.rows;
  }

  it('writes a succeeded audit row for an executed call, none for a denied one', async () => {
    const { runtime, worker, executed } = setup();
    try {
      const search = await runtime.enqueue({
        scope: 'scope-audits',
        prompt: 'Find the roadmap note',
        maxAttempts: 1,
      });
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, search.invocationId);
        return row?.status === 'succeeded';
      });
      const searchRow = await getInvocationRowById(
        handle.db,
        search.invocationId,
      );
      const searchAudits = await auditsFor(search.invocationId);
      expect(searchAudits).toHaveLength(1);
      expect(searchAudits[0]).toMatchObject({
        tool_name: 'notes__search',
        status: 'succeeded',
        scope: 'scope-audits',
        error_code: null,
        request_snapshot: { query: 'roadmap' },
      });
      expect(searchAudits[0]?.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
      expect(searchAudits[0]?.run_id).toBe(searchRow?.activeRunId);
      expect(searchAudits[0]?.completed_at).not.toBeNull();

      const refund = await runtime.enqueue({
        scope: 'scope-audits',
        prompt: 'Refund order 42: 5000 cents, duplicate charge.',
        maxAttempts: 1,
      });
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, refund.invocationId);
        return row?.status === 'awaiting_approval';
      });
      expect(await auditsFor(refund.invocationId)).toEqual([]);
      expect(executed.refund).toBe(0);

      await runtime.approveInvocation(refund.invocationId);
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, refund.invocationId);
        return row?.status === 'succeeded';
      });
      const refundAudits = await auditsFor(refund.invocationId);
      expect(refundAudits).toHaveLength(1);
      expect(refundAudits[0]).toMatchObject({
        tool_name: 'billing__refund',
        status: 'succeeded',
        request_snapshot: { amountCents: 5000, reason: 'duplicate charge' },
      });
      expect(executed.refund).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it('reclaims the same audit row when a failed call is retried', async () => {
    const { runtime, worker, executed, failNextSearch } = setup();
    try {
      failNextSearch();
      const { invocationId } = await runtime.enqueue({
        scope: 'scope-audits-retry',
        prompt: 'Find the roadmap note',
        maxAttempts: 2,
      });
      await waitFor(async () => {
        const audits = await auditsFor(invocationId);
        return audits.length === 1 && audits[0]?.status === 'failed';
      });
      const failed = (await auditsFor(invocationId))[0];
      expect(failed?.error_code).toBe('tool_call_failed');
      expect(failed?.completed_at).not.toBeNull();
      expect(executed.search).toBe(0);

      await handle.pool.query(
        `update agent_runtime.invocations set next_attempt_at = now() where id = $1`,
        [invocationId],
      );
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, invocationId);
        return row?.status === 'succeeded';
      });
      const audits = await auditsFor(invocationId);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.id).toBe(failed?.id);
      expect(audits[0]?.idempotency_key).toBe(failed?.idempotency_key);
      expect(audits[0]?.run_id).not.toBe(failed?.run_id);
      expect(audits[0]).toMatchObject({
        status: 'succeeded',
        error_code: null,
      });
      expect(executed.search).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it('blocks execution when audit rows cannot be written', async () => {
    const { runtime, worker, executed } = setup();
    await handle.pool.query(`
      create or replace function agent_runtime.reject_tool_call_audits()
      returns trigger language plpgsql as $$
      begin
        raise exception 'tool_call_audits unavailable';
      end;
      $$;
      create trigger reject_tool_call_audits_trigger
        before insert on agent_runtime.tool_call_audits
        for each row execute function agent_runtime.reject_tool_call_audits();
    `);
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'scope-audits-blocked',
        prompt: 'Find the roadmap note',
        maxAttempts: 1,
      });
      await waitFor(async () => {
        const row = await getInvocationRowById(handle.db, invocationId);
        return row?.status === 'failed';
      });
      const row = await getInvocationRowById(handle.db, invocationId);
      expect(row?.lastErrorCode).toBe('audit_persistence_failed');
      expect(executed.search).toBe(0);
      expect(await auditsFor(invocationId)).toEqual([]);
    } finally {
      await handle.pool.query(`
        drop trigger if exists reject_tool_call_audits_trigger
          on agent_runtime.tool_call_audits;
        drop function if exists agent_runtime.reject_tool_call_audits();
      `);
      await worker.stop();
    }
  });
});
