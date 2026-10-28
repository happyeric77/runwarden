import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

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
import { defineRuntime } from '../define-runtime';
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
    // A worker claims the row with a short lease and never completes it.
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
    const worker = runWorker({
      runtime: { engine },
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      await waitFor(async () => {
        const a = await getInvocationRowById(handle.db, first.invocationId);
        const b = await getInvocationRowById(handle.db, second.invocationId);
        return a?.status === 'succeeded' && b?.status === 'succeeded';
      });
      expect(events.indexOf('end:one')).toBeLessThan(
        events.indexOf('start:two'),
      );
    } finally {
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
    const fakeMcpClient: McpToolClient = {
      async open() {
        return {
          async callTool() {
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
      expect(decisions.rows.length).toBeGreaterThanOrEqual(2);
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
