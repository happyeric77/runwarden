import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

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

  it('fails the invocation instead of silently losing an audit write', async () => {
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
  });

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
              { type: 'text', text: 'Note found: "Roadmap" — ship it.' },
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
