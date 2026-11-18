import { MockLanguageModelV4 } from 'ai/test';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AgentRuntimeError } from '../contracts/errors.js';
import type { PolicyDecision, RuntimePolicies } from '../contracts/policy.js';
import type {
  InvocationRecord,
  McpToolClient,
  ToolCallAuditEvent,
  ToolCallAuditSink,
} from '../contracts/runtime.js';
import { createDb, type DatabaseHandle } from '../db/client.js';
import { initDb } from '../db/init.js';
import {
  claimInvocations,
  enqueueInvocation,
  getInvocationRowById,
  heartbeatInvocation,
  markInvocationSucceeded,
} from '../db/repositories/invocations.js';
import {
  startTestPostgres,
  waitFor,
  type TestPostgres,
} from '../db/test-postgres.js';
import { defineRuntime, RUNTIME_INTERNALS } from '../define-runtime.js';
import { FakeAgentRuntime } from '../fake-runtime.js';
import { emptyInvocationUsage } from '../runtime/usage.js';
import { runWorker } from './run-worker.js';
import { fakeMcpClient, finishStep } from './test-helpers.js';

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
    const { claimed } = await claimInvocations(handle.db, 'worker-crashed', {
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
          messages: [],
          usage: emptyInvocationUsage(),
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
              messages: [],
              usage: emptyInvocationUsage(),
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
              messages: [],
              usage: emptyInvocationUsage(),
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
              messages: [],
              usage: emptyInvocationUsage(),
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
              messages: [],
              usage: emptyInvocationUsage(),
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
                messages: [],
                usage: emptyInvocationUsage(),
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

  it('preserves a budget stop and its usage when audit persistence fails', async () => {
    await handle.pool.query(
      `create function agent_runtime.reject_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$`,
    );
    await handle.pool.query(
      'create trigger reject_audit before insert on agent_runtime.policy_decisions for each row execute function agent_runtime.reject_audit()',
    );
    let listener: ((decision: PolicyDecision) => void) | undefined;
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-audit-budget',
      prompt: 'budget',
      maxAttempts: 3,
    });
    const usage = {
      ...emptyInvocationUsage(),
      inputTokens: 6,
      outputTokens: 5,
      costIncomplete: true,
      steps: [
        {
          provider: 'mock-provider',
          model: 'mock-model',
          inputTokens: 6,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          usageKnown: true,
          costKnown: false,
        },
      ],
    };
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
            listener?.({
              ...input,
              rule: 'budget',
              decision: 'warning',
              detail: { limitKind: 'tokens', accumulated: 6, limit: 10 },
            });
            listener?.({
              ...input,
              rule: 'budget',
              decision: 'exceeded',
              detail: { limitKind: 'tokens', accumulated: 11, limit: 10 },
            });
            throw new AgentRuntimeError(
              'budget',
              'Invocation budget exceeded',
              {
                code: 'budget_exceeded',
                limits: [
                  {
                    limitKind: 'tokens',
                    accumulated: 11,
                    limit: 10,
                    stepNumber: 1,
                    completeness: 'complete',
                  },
                ],
              },
              { usage },
            );
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
      expect(row?.lastErrorCode).toBe('budget_exceeded');
      expect(row?.attemptCount).toBe(1);
      expect(row?.inputTokens).toBe(6);
      expect(row?.outputTokens).toBe(5);
      expect(row?.usageSteps).toEqual(usage.steps);
      const decisions = await handle.pool.query(
        'select count(*)::int as count from agent_runtime.policy_decisions where invocation_id=$1',
        [invocationId],
      );
      expect(decisions.rows[0].count).toBe(0);
    } finally {
      await worker.stop();
      await handle.pool.query(
        'drop trigger reject_audit on agent_runtime.policy_decisions',
      );
      await handle.pool.query('drop function agent_runtime.reject_audit()');
    }
  });

  it('fails closed instead of parking when the crossing audit cannot persist', async () => {
    await handle.pool.query(
      `create function agent_runtime.reject_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$`,
    );
    await handle.pool.query(
      'create trigger reject_audit before insert on agent_runtime.policy_decisions for each row execute function agent_runtime.reject_audit()',
    );
    let listener: ((decision: PolicyDecision) => void) | undefined;
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'scope-audit-budget-park',
      prompt: 'budget',
      maxAttempts: 3,
    });
    const usage = {
      ...emptyInvocationUsage(),
      inputTokens: 6,
      outputTokens: 5,
      costIncomplete: true,
      steps: [
        {
          provider: 'mock-provider',
          model: 'mock-model',
          inputTokens: 6,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          usageKnown: true,
          costKnown: false,
        },
      ],
    };
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
            listener?.({
              ...input,
              rule: 'budget',
              decision: 'exceeded',
              detail: { limitKind: 'tokens', accumulated: 11, limit: 10 },
            });
            throw new AgentRuntimeError(
              'budget',
              'Budget approval required',
              {
                code: 'budget_approval_required',
                limits: [
                  {
                    limitKind: 'tokens',
                    accumulated: 11,
                    limit: 10,
                    stepNumber: 1,
                    completeness: 'complete',
                  },
                ],
              },
              { usage },
            );
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
      expect(row).toMatchObject({
        status: 'failed',
        lastErrorCode: 'audit_persistence_failed',
        pendingBudgetRequest: null,
        inputTokens: 6,
        outputTokens: 5,
      });
      expect(
        (
          await handle.pool.query(
            'select count(*)::int as count from agent_runtime.policy_decisions where invocation_id=$1',
            [invocationId],
          )
        ).rows[0].count,
      ).toBe(0);
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
              messages: [],
              usage: emptyInvocationUsage(),
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

  it('persists invocation messages and returns them from a durable result', async () => {
    const listResult =
      '[{"type":"text","text":"1: booking one, 2: booking two"}]';
    const fakeMcpClient: McpToolClient = {
      async open() {
        return {
          async callTool() {
            return listResult;
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
        if (promptText.includes('1: booking one')) {
          return finish([{ type: 'text', text: 'Found two bookings.' }]);
        }
        return finish([
          {
            type: 'tool-call',
            toolCallId: 'list-durable',
            toolName: 'tasks__list_scheduled',
            input: JSON.stringify({ query_mode: 'upcoming' }),
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
          name: 'tasks__list_scheduled',
          description: 'List scheduled tasks.',
          inputSchema: z.object({ query_mode: z.string() }),
        },
      ],
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const result = await runtime.invoke(
        { scope: 'scope-durable-messages', prompt: 'List my tasks' },
        { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
      );
      expect(result.messages).toEqual([
        { role: 'user', content: 'List my tasks' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'list-durable',
              toolName: 'tasks__list_scheduled',
              input: { query_mode: 'upcoming' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'list-durable',
              toolName: 'tasks__list_scheduled',
              output: { type: 'text', value: listResult },
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Found two bookings.' }],
        },
      ]);
    } finally {
      await worker.stop();
    }
  });

  it('persists usage totals and per-step detail for a durable invocation', async () => {
    const listResult =
      '[{"type":"text","text":"1: booking one, 2: booking two"}]';
    const mcp = fakeMcpClient(listResult);
    const stepUsage = {
      inputTokens: {
        total: 10,
        noCache: 4,
        cacheRead: 3,
        cacheWrite: 3,
      },
      outputTokens: { total: 6, text: 4, reasoning: 2 },
    };
    const model = new MockLanguageModelV4({
      modelId: 'mock-model',
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        if (promptText.includes('1: booking one')) {
          return finishStep(
            [{ type: 'text', text: 'Found two bookings.' }],
            stepUsage,
          );
        }
        return finishStep(
          [
            {
              type: 'tool-call',
              toolCallId: 'usage-durable',
              toolName: 'tasks__list_scheduled',
              input: JSON.stringify({ query_mode: 'upcoming' }),
            },
          ],
          stepUsage,
        );
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: mcp.client,
      tools: [
        {
          name: 'tasks__list_scheduled',
          description: 'List scheduled tasks.',
          inputSchema: z.object({ query_mode: z.string() }),
        },
      ],
      pricing: {
        overrides: [
          {
            model: 'mock-model',
            inputPerMillionTokens: 1,
            outputPerMillionTokens: 2,
            cacheReadPerMillionTokens: 0.5,
            cacheWritePerMillionTokens: 0.25,
          },
        ],
      },
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const result = await runtime.invoke(
        { scope: 'scope-durable-usage', prompt: 'List my tasks' },
        { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
      );

      expect(result.usage).toMatchObject({
        inputTokens: 8,
        outputTokens: 8,
        cacheReadTokens: 6,
        cacheWriteTokens: 6,
        reasoningTokens: 4,
        costIncomplete: false,
      });
      expect(result.usage.costUsd).toBeCloseTo(0.0000365, 12);
      expect(result.usage.steps).toHaveLength(2);

      const row = await getInvocationRowById(handle.db, result.invocationId);
      expect(row).toMatchObject({
        inputTokens: 8,
        outputTokens: 8,
        cacheReadTokens: 6,
        cacheWriteTokens: 6,
        reasoningTokens: 4,
      });
      expect(row?.costUsd).toBeCloseTo(0.0000365, 12);
      expect(row?.usageSteps).toEqual(result.usage.steps);

      const readBack = await runtime.waitForInvocation(result.invocationId, {
        pollIntervalMs: 10,
        waitTimeoutMs: 1_000,
      });
      expect(readBack.usage).toEqual(result.usage);
    } finally {
      await worker.stop();
    }
  });

  it('stops a durable invocation on a token budget and persists usage without retry', async () => {
    const mcp = fakeMcpClient(
      '[{"type":"text","text":"1: booking one, 2: booking two"}]',
    );
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-model',
      doGenerate: async (options) => {
        modelCalls += 1;
        const promptText = JSON.stringify(options.prompt);
        if (promptText.includes('1: booking one')) {
          return finishStep([{ type: 'text', text: 'Should not be reached.' }]);
        }
        return finishStep(
          [
            {
              type: 'tool-call',
              toolCallId: 'budget-durable',
              toolName: 'tasks__list_scheduled',
              input: JSON.stringify({ query_mode: 'upcoming' }),
            },
          ],
          {
            inputTokens: { total: 6, noCache: 6 },
            outputTokens: { total: 5, text: 5 },
          },
        );
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: mcp.client,
      tools: [
        {
          name: 'tasks__list_scheduled',
          description: 'List scheduled tasks.',
          inputSchema: z.object({ query_mode: z.string() }),
        },
      ],
      policies: { budget: { maxTokens: 10 } },
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      let caught: unknown;
      try {
        await runtime.invoke(
          {
            scope: 'scope-durable-budget',
            prompt: 'List my tasks',
            maxAttempts: 3,
          },
          { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AgentRuntimeError);
      const error = caught as AgentRuntimeError;
      expect(error.kind).toBe('budget');
      expect(error.diagnostics).toMatchObject({
        code: 'budget_exceeded',
        invocationId: expect.any(String),
        runId: expect.any(String),
      });
      expect(error.usage).toMatchObject({
        inputTokens: 6,
        outputTokens: 5,
        costIncomplete: true,
      });
      expect(error.usage?.steps).toHaveLength(1);

      const invocationId = error.diagnostics.invocationId as string;
      const row = await getInvocationRowById(handle.db, invocationId);
      expect(row).toMatchObject({
        status: 'failed',
        attemptCount: 1,
        inputTokens: 6,
        outputTokens: 5,
        lastErrorCode: 'budget_exceeded',
      });
      expect(row?.usageSteps).toEqual(error.usage?.steps);
      expect(modelCalls).toBe(1);
      expect(mcp.calls()).toBe(1);

      const decisions = await handle.pool.query<{ decision: string }>(
        `select decision from agent_runtime.policy_decisions
         where invocation_id = $1 and rule = 'budget'
         order by id`,
        [invocationId],
      );
      expect(decisions.rows.map((decision) => decision.decision)).toEqual(
        expect.arrayContaining(['warning', 'exceeded']),
      );

      await expect(
        runtime.waitForInvocation(invocationId, {
          pollIntervalMs: 10,
          waitTimeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({
        kind: 'budget',
        diagnostics: {
          code: 'budget_exceeded',
          invocationId,
        },
        usage: error.usage,
      });
    } finally {
      await worker.stop();
    }
  });

  it('parks a durable budget crossing and resumes with an approved grant', async () => {
    const mcp = fakeMcpClient('[{"type":"text","text":"task result"}]');
    const settled: InvocationRecord[] = [];
    const parkedRequests: Array<{ kind: string }> = [];
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-model',
      doGenerate: async (options) => {
        modelCalls += 1;
        const promptText = JSON.stringify(options.prompt);
        if (promptText.includes('task result')) {
          return finishStep([{ type: 'text', text: 'Done.' }], {
            inputTokens: { total: 1, noCache: 1 },
            outputTokens: { total: 1, text: 1 },
          });
        }
        return finishStep(
          [
            {
              type: 'tool-call',
              toolCallId: 'budget-park',
              toolName: 'tasks__list_scheduled',
              input: JSON.stringify({ query_mode: 'upcoming' }),
            },
          ],
          {
            inputTokens: { total: 6, noCache: 6 },
            outputTokens: { total: 5, text: 5 },
          },
        );
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: mcp.client,
      tools: [
        {
          name: 'tasks__list_scheduled',
          description: 'List scheduled tasks.',
          inputSchema: z.object({ query_mode: z.string() }),
        },
      ],
      policies: { budget: { maxTokens: 10, onExceeded: 'approve' } },
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
      onInvocationSettled: (record) => {
        settled.push(record);
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 20,
      pollActiveMs: 10,
      onAwaitingApproval: async (_record, request) => {
        parkedRequests.push({ kind: request.kind });
      },
    });
    try {
      const parked = await runtime.enqueue({
        scope: 'scope-budget-approval',
        prompt: 'List my tasks',
        maxAttempts: 1,
        orderingKey: 'budget-order',
      });
      await waitFor(
        async () =>
          (await runtime.getInvocation(parked.invocationId))?.status ===
          'awaiting_approval',
      );
      const parkedRow = await getInvocationRowById(
        handle.db,
        parked.invocationId,
      );
      expect(parkedRow).toMatchObject({
        status: 'awaiting_approval',
        attemptCount: 0,
        inputTokens: 6,
        outputTokens: 5,
        pendingToolCall: null,
        budgetGrants: null,
      });
      expect(parkedRow?.pendingBudgetRequest).toMatchObject({
        requestId: parkedRow?.activeRunId,
        limits: [{ limitKind: 'tokens', accumulated: 11, limit: 10 }],
        usage: { inputTokens: 6, outputTokens: 5 },
      });
      expect(parkedRow?.pendingBudgetRequest?.requestId).toBe(
        parkedRow?.activeRunId,
      );
      const parkedRunId = parkedRow!.activeRunId!;
      expect(parkedRequests).toEqual([{ kind: 'budget' }]);
      expect(settled).toHaveLength(0);
      expect(modelCalls).toBe(1);
      expect(mcp.calls()).toBe(1);

      const pending = await runtime.listPendingApprovals(
        'scope-budget-approval',
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: parked.invocationId,
        pendingApprovalKind: 'budget',
        pendingBudgetRequest: { requestId: parkedRunId },
      });
      expect(pending[0]?.pendingToolCall).toBeUndefined();

      const follower = await runtime.enqueue({
        scope: 'scope-budget-approval',
        prompt: 'Follower',
        orderingKey: 'budget-order',
      });
      await sleep(150);
      expect((await runtime.getInvocation(follower.invocationId))?.status).toBe(
        'pending',
      );

      await expect(
        runtime.approveInvocation(parked.invocationId, {
          grant: { maxTokens: 5 },
        }),
      ).rejects.toMatchObject({
        diagnostics: { code: 'approval_request_stale' },
      });
      expect((await runtime.getInvocation(parked.invocationId))?.status).toBe(
        'awaiting_approval',
      );

      const approved = await runtime.approveInvocation(parked.invocationId, {
        grant: { maxTokens: 5 },
        requestId: parkedRunId,
        resolvedBy: 'admin-1',
      });
      expect(approved.status).toBe('pending');
      expect(approved.budgetGrants).toEqual({ maxTokens: 5 });

      const result = await runtime.waitForInvocation(parked.invocationId, {
        pollIntervalMs: 20,
        waitTimeoutMs: 30_000,
      });
      expect(result.text).toBe('Done.');
      const finished = await getInvocationRowById(
        handle.db,
        parked.invocationId,
      );
      expect(finished).toMatchObject({
        status: 'succeeded',
        attemptCount: 1,
        budgetGrants: { maxTokens: 5 },
        pendingBudgetRequest: null,
      });
      expect(finished?.activeRunId).not.toBe(parkedRunId);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        id: parked.invocationId,
        status: 'succeeded',
      });
      const decisions = await handle.pool.query<{ decision: string }>(
        `select decision from agent_runtime.policy_decisions
          where invocation_id = $1 and rule = 'budget' order by id`,
        [parked.invocationId],
      );
      expect(
        decisions.rows
          .map((row) => row.decision)
          .filter(
            (decision) => decision !== 'warning' && decision !== 'exceeded',
          ),
      ).toEqual(['approval_requested', 'approved']);

      // The ordering key stays held until settlement; the follower now parks.
      await waitFor(
        async () =>
          (await runtime.getInvocation(follower.invocationId))?.status ===
          'awaiting_approval',
      );
      expect(modelCalls).toBe(4);
      expect(mcp.calls()).toBe(3);
      const followerRow = await getInvocationRowById(
        handle.db,
        follower.invocationId,
      );
      await runtime.rejectInvocation(follower.invocationId, {
        requestId: followerRow!.pendingBudgetRequest!.requestId,
      });
    } finally {
      await worker.stop();
    }
  });

  it('rejects a durable budget park without retrying and keeps park usage', async () => {
    const mcp = fakeMcpClient('[{"type":"text","text":"task result"}]');
    const settled: InvocationRecord[] = [];
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-model',
      doGenerate: async () => {
        modelCalls += 1;
        return finishStep(
          [
            {
              type: 'tool-call',
              toolCallId: 'budget-reject',
              toolName: 'tasks__list_scheduled',
              input: JSON.stringify({ query_mode: 'upcoming' }),
            },
          ],
          {
            inputTokens: { total: 6, noCache: 6 },
            outputTokens: { total: 5, text: 5 },
          },
        );
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: mcp.client,
      tools: [
        {
          name: 'tasks__list_scheduled',
          description: 'List scheduled tasks.',
          inputSchema: z.object({ query_mode: z.string() }),
        },
      ],
      policies: { budget: { maxTokens: 10, onExceeded: 'approve' } },
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
      onInvocationSettled: (record) => {
        settled.push(record);
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 20,
      pollActiveMs: 10,
    });
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'scope-budget-reject',
        prompt: 'List my tasks',
        maxAttempts: 3,
      });
      await waitFor(
        async () =>
          (await runtime.getInvocation(invocationId))?.status ===
          'awaiting_approval',
      );
      const parked = await getInvocationRowById(handle.db, invocationId);
      const rejected = await runtime.rejectInvocation(invocationId, {
        requestId: parked!.pendingBudgetRequest!.requestId,
        note: 'quota denied',
      });
      expect(rejected).toMatchObject({
        status: 'failed',
        lastErrorCode: 'budget_exceeded',
        lastErrorMessage: 'quota denied',
      });
      expect(await getInvocationRowById(handle.db, invocationId)).toMatchObject(
        { inputTokens: 6, outputTokens: 5, pendingBudgetRequest: null },
      );
      await expect(
        runtime.waitForInvocation(invocationId, {
          pollIntervalMs: 10,
          waitTimeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({
        kind: 'budget',
        diagnostics: { code: 'budget_exceeded' },
        usage: { inputTokens: 6, outputTokens: 5 },
      });
      await sleep(250);
      expect(modelCalls).toBe(1);
      // Parking handed the claim back; rejection must not requeue or spend it.
      expect(
        (await getInvocationRowById(handle.db, invocationId))?.attemptCount,
      ).toBe(0);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        id: invocationId,
        status: 'failed',
        lastErrorCode: 'budget_exceeded',
      });
    } finally {
      await worker.stop();
    }
  });

  it('parks again when a resumed run crosses its raised limit', async () => {
    const mcp = fakeMcpClient('[{"type":"text","text":"task result"}]');
    const model = new MockLanguageModelV4({
      modelId: 'mock-model',
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        if (promptText.includes('task result')) {
          return finishStep([{ type: 'text', text: 'Done.' }], {
            inputTokens: { total: 1, noCache: 1 },
            outputTokens: { total: 1, text: 1 },
          });
        }
        return finishStep(
          [
            {
              type: 'tool-call',
              toolCallId: 'budget-repark',
              toolName: 'tasks__list_scheduled',
              input: JSON.stringify({ query_mode: 'upcoming' }),
            },
          ],
          {
            inputTokens: { total: 6, noCache: 6 },
            outputTokens: { total: 5, text: 5 },
          },
        );
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: mcp.client,
      tools: [
        {
          name: 'tasks__list_scheduled',
          description: 'List scheduled tasks.',
          inputSchema: z.object({ query_mode: z.string() }),
        },
      ],
      policies: { budget: { maxTokens: 10, onExceeded: 'approve' } },
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 20,
      pollActiveMs: 10,
    });
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'scope-budget-repark',
        prompt: 'List my tasks',
        maxAttempts: 1,
      });
      await waitFor(
        async () =>
          (await runtime.getInvocation(invocationId))?.status ===
          'awaiting_approval',
      );
      const firstPark = await getInvocationRowById(handle.db, invocationId);
      const firstRunId = firstPark!.pendingBudgetRequest!.requestId;
      await runtime.approveInvocation(invocationId, {
        grant: { maxTokens: 1 },
        requestId: firstRunId,
      });

      // The 11-token step now equals the raised 11-token limit and parks again.
      await waitFor(
        async () =>
          (await runtime.getInvocation(invocationId))?.status ===
          'awaiting_approval',
      );
      const secondPark = await getInvocationRowById(handle.db, invocationId);
      const secondRunId = secondPark!.pendingBudgetRequest!.requestId;
      expect(secondRunId).not.toBe(firstRunId);
      expect(secondPark?.budgetGrants).toEqual({ maxTokens: 1 });
      expect(secondPark?.pendingBudgetRequest?.limits).toMatchObject([
        { accumulated: 11, limit: 11 },
      ]);
      await runtime.approveInvocation(invocationId, {
        grant: { maxTokens: 10 },
        requestId: secondRunId,
      });
      await expect(
        runtime.waitForInvocation(invocationId, {
          pollIntervalMs: 20,
          waitTimeoutMs: 30_000,
        }),
      ).resolves.toMatchObject({ text: 'Done.' });
      const finished = await getInvocationRowById(handle.db, invocationId);
      expect(finished).toMatchObject({
        status: 'succeeded',
        budgetGrants: { maxTokens: 11 },
        attemptCount: 1,
      });
      const decisions = await handle.pool.query<{ decision: string }>(
        `select decision from agent_runtime.policy_decisions
          where invocation_id = $1 and rule = 'budget' order by id`,
        [invocationId],
      );
      expect(
        decisions.rows
          .map((row) => row.decision)
          .filter(
            (decision) => decision !== 'warning' && decision !== 'exceeded',
          ),
      ).toEqual([
        'approval_requested',
        'approved',
        'approval_requested',
        'approved',
      ]);
    } finally {
      await worker.stop();
    }
  });

  it('completes successfully when provider usage contains invalid token counts', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'invalid-usage-model',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Still completed.' }] as never,
        finishReason: { unified: 'stop', raw: 'stop' } as const,
        usage: {
          inputTokens: {
            total: Number.NaN,
            noCache: 1.5,
            cacheRead: -1,
            cacheWrite: 0,
          },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const result = await runtime.invoke(
        { scope: 'scope-durable-invalid-usage', prompt: 'Finish anyway' },
        { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
      );

      expect(result.text).toBe('Still completed.');
      expect(result.usage).toMatchObject({
        inputTokens: 0,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costIncomplete: true,
      });
      expect(result.usage).not.toHaveProperty('costUsd');

      const row = await getInvocationRowById(handle.db, result.invocationId);
      expect(row).toMatchObject({
        status: 'succeeded',
        inputTokens: 0,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
      });
      expect(row?.usageSteps?.[0]).toMatchObject({
        usageKnown: false,
        costKnown: false,
      });
    } finally {
      await worker.stop();
    }
  });

  it('completes when aggregate token totals overflow and marks usage incomplete', async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const stepUsage = {
      inputTokens: {
        total: max,
        noCache: max,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      modelId: 'token-overflow-model',
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        const finish = (content: unknown[]) => ({
          content: content as never,
          finishReason: { unified: 'stop', raw: 'stop' } as const,
          usage: stepUsage,
          warnings: [],
        });
        if (promptText.includes('1: booking one')) {
          return finish([{ type: 'text', text: 'Found two bookings.' }]);
        }
        return finish([
          {
            type: 'tool-call',
            toolCallId: 'token-overflow',
            toolName: 'tasks__list_scheduled',
            input: JSON.stringify({ query_mode: 'upcoming' }),
          },
        ]);
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: {
        async open() {
          return {
            async callTool() {
              return '[{"type":"text","text":"1: booking one, 2: booking two"}]';
            },
            async close() {},
          };
        },
      },
      tools: [
        {
          name: 'tasks__list_scheduled',
          description: 'List scheduled tasks.',
          inputSchema: z.object({ query_mode: z.string() }),
        },
      ],
      pricing: {
        overrides: [
          {
            model: 'token-overflow-model',
            inputPerMillionTokens: 0,
            outputPerMillionTokens: 0,
          },
        ],
      },
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const result = await runtime.invoke(
        { scope: 'scope-durable-token-overflow', prompt: 'List my tasks' },
        { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
      );

      expect(result.usage).toMatchObject({
        inputTokens: max,
        costUsd: 0,
        costIncomplete: true,
      });
      expect(result.usage.steps.every((step) => step.costKnown)).toBe(true);

      const row = await getInvocationRowById(handle.db, result.invocationId);
      expect(row).toMatchObject({
        status: 'succeeded',
        inputTokens: max,
        costUsd: 0,
      });
      expect(row?.usageSteps).toEqual(result.usage.steps);

      const readBack = await runtime.waitForInvocation(result.invocationId, {
        pollIntervalMs: 10,
        waitTimeoutMs: 1_000,
      });
      expect(readBack.usage).toEqual(result.usage);
    } finally {
      await worker.stop();
    }
  });

  it('keeps durable cost incomplete when aggregate cost overflows', async () => {
    const stepUsage = {
      inputTokens: {
        total: 1_000_000,
        noCache: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      modelId: 'cost-overflow-model',
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        const finish = (content: unknown[]) => ({
          content: content as never,
          finishReason: { unified: 'stop', raw: 'stop' } as const,
          usage: stepUsage,
          warnings: [],
        });
        if (promptText.includes('1: booking one')) {
          return finish([{ type: 'text', text: 'Completed.' }]);
        }
        return finish([
          {
            type: 'tool-call',
            toolCallId: 'cost-overflow',
            toolName: 'tasks__list_scheduled',
            input: JSON.stringify({ query_mode: 'upcoming' }),
          },
        ]);
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: {
        async open() {
          return {
            async callTool() {
              return '[{"type":"text","text":"1: booking one"}]';
            },
            async close() {},
          };
        },
      },
      tools: [
        {
          name: 'tasks__list_scheduled',
          description: 'List scheduled tasks.',
          inputSchema: z.object({ query_mode: z.string() }),
        },
      ],
      pricing: {
        overrides: [
          {
            model: 'cost-overflow-model',
            inputPerMillionTokens: 600_000_000_000_000_000,
            outputPerMillionTokens: 0,
          },
        ],
      },
      loadSystemPrompt: async () => 'You are a helpful task assistant.',
      loadHistory: async () => [],
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const result = await runtime.invoke(
        { scope: 'scope-durable-cost-overflow', prompt: 'Finish' },
        { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
      );

      expect(result.usage).toMatchObject({ costIncomplete: true });
      expect(result.usage).not.toHaveProperty('costUsd');
      expect(result.usage.steps.every((step) => step.costKnown)).toBe(true);

      const row = await getInvocationRowById(handle.db, result.invocationId);
      expect(row).toMatchObject({ status: 'succeeded', costUsd: null });

      const readBack = await runtime.waitForInvocation(result.invocationId, {
        pollIntervalMs: 10,
        waitTimeoutMs: 1_000,
      });
      expect(readBack.usage).toEqual(result.usage);
    } finally {
      await worker.stop();
    }
  });

  it('returns no messages for a row stored before result_messages existed', async () => {
    const runtime = defineRuntime({
      db: handle,
      model: new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'unused' }] as never,
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
        }),
      }),
    });
    const { invocationId } = await runtime.enqueue({
      scope: 'scope-durable-legacy',
      prompt: 'legacy invocation',
    });
    const { claimed } = await claimInvocations(handle.db, 'legacy-worker', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    const row = claimed.find((entry) => String(entry.id) === invocationId);
    expect(row).toBeDefined();
    await markInvocationSucceeded(
      handle.db,
      Number(invocationId),
      'legacy-worker',
      row!.activeRunId!,
      { resultText: 'legacy result' },
    );

    const result = await runtime.waitForInvocation(invocationId, {
      pollIntervalMs: 10,
      waitTimeoutMs: 1_000,
    });
    expect(result.text).toBe('legacy result');
    expect(result.messages).toEqual([]);
    expect(result.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costIncomplete: true,
      steps: [],
    });
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

  function setup(
    requireApproval: RuntimePolicies['requireApproval'] = ['billing__refund'],
  ) {
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
      policies: { requireApproval },
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

  it('applies a refund threshold and reruns the approved call', async () => {
    const predicate = vi.fn(
      ({
        toolName,
        input,
      }: {
        scope: string;
        toolName: string;
        input: unknown;
      }) =>
        toolName === 'billing__refund' &&
        (input as { amountCents: number }).amountCents > 5000,
    );
    const { runtime, worker, executed, setAmount } = setup(predicate);
    try {
      setAmount(4900);
      const small = await runtime.invoke(
        { scope: 'threshold', prompt: 'Refund', maxAttempts: 1 },
        { pollIntervalMs: 50, waitTimeoutMs: 30_000 },
      );
      expect(executed()).toBe(1);
      expect(await decisionsFor(small.invocationId)).not.toContain(
        'approval_requested',
      );
      setAmount(5100);
      const { invocationId } = await runtime.enqueue({
        scope: 'threshold',
        prompt: 'Refund',
        maxAttempts: 1,
      });
      await waitFor(
        async () =>
          (await runtime.getInvocation(invocationId))?.status ===
          'awaiting_approval',
      );
      expect(executed()).toBe(1);
      expect(await decisionsFor(invocationId)).toContain('approval_requested');
      await runtime.approveInvocation(invocationId, { resolvedBy: 'admin-1' });
      await runtime.waitForInvocation(invocationId, {
        pollIntervalMs: 50,
        waitTimeoutMs: 30_000,
      });
      expect(executed()).toBe(2);
      const result = await handle.pool.query(
        `select detail from agent_runtime.policy_decisions where invocation_id = $1 and rule = 'require_approval' and decision = 'allow'`,
        [invocationId],
      );
      expect(result.rows).toContainEqual({
        detail: expect.objectContaining({ viaApproval: true }),
      });
      expect(
        predicate.mock.calls.filter(
          ([call]) =>
            (call.input as { amountCents: number }).amountCents === 5100,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await worker.stop();
    }
  });

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

describe('invocation settled callbacks', () => {
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

  function textModel(text: string) {
    return new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text }],
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
      }),
    });
  }

  it('fires once with the final record when an invocation succeeds', async () => {
    const settled: InvocationRecord[] = [];
    const runtime = defineRuntime({
      db: handle,
      model: textModel('All done.'),
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      onInvocationSettled: (invocation) => {
        settled.push(invocation);
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'settled-success',
        prompt: 'Say hi',
      });
      await waitFor(async () => settled.length === 1);
      await sleep(200);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        id: invocationId,
        scope: 'settled-success',
        status: 'succeeded',
        resultText: 'All done.',
      });
      expect(settled[0]?.completedAt).toBeTruthy();
    } finally {
      await worker.stop();
    }
  });

  it('fires once when an invocation fails its final attempt', async () => {
    const settled: InvocationRecord[] = [];
    const runtime = defineRuntime({
      db: handle,
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error('provider exploded');
        },
      }),
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      onInvocationSettled: (invocation) => {
        settled.push(invocation);
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
      retryDelayMs: 10,
    });
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'settled-failure',
        prompt: 'Boom',
        maxAttempts: 1,
      });
      await waitFor(async () => settled.length === 1);
      expect(settled[0]).toMatchObject({
        id: invocationId,
        status: 'failed',
      });
      expect(settled[0]?.lastErrorCode).toBeTruthy();
    } finally {
      await worker.stop();
    }
  });

  it('isolates throwing settled callbacks on rejection and approved completion', async () => {
    const settled: InvocationRecord[] = [];
    const fakeMcpClient: McpToolClient = {
      async open() {
        return {
          async callTool() {
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
              amountCents: 5000,
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
      onInvocationSettled: async (invocation) => {
        settled.push(invocation);
        throw new Error('observer bug');
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const rejected = await runtime.enqueue({
        scope: 'settled-cancelled',
        prompt: 'Refund order 42',
        maxAttempts: 1,
      });
      await waitFor(
        async () =>
          (await runtime.getInvocation(rejected.invocationId))?.status ===
          'awaiting_approval',
      );
      expect(settled).toHaveLength(0);
      await runtime.rejectInvocation(rejected.invocationId);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        id: rejected.invocationId,
        status: 'cancelled',
        lastErrorCode: 'approval_rejected',
      });

      const approved = await runtime.enqueue({
        scope: 'settled-approved',
        prompt: 'Refund order 42',
        maxAttempts: 1,
      });
      await waitFor(
        async () =>
          (await runtime.getInvocation(approved.invocationId))?.status ===
          'awaiting_approval',
      );
      await runtime.approveInvocation(approved.invocationId);
      const result = await runtime.waitForInvocation(approved.invocationId, {
        pollIntervalMs: 50,
        waitTimeoutMs: 30_000,
      });
      expect(result.text).toBe('Refund completed.');
      await waitFor(async () => settled.length === 2);
      await sleep(200);
      expect(settled).toHaveLength(2);
      expect(settled[1]).toMatchObject({
        id: approved.invocationId,
        status: 'succeeded',
      });
    } finally {
      await worker.stop();
    }
  });

  it('a throwing settled callback does not affect the invocation', async () => {
    let callbackCount = 0;
    const runtime = defineRuntime({
      db: handle,
      model: textModel('Fine.'),
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      onInvocationSettled: () => {
        callbackCount++;
        throw new Error('observer bug');
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'settled-throwing',
        prompt: 'Say hi',
      });
      const result = await runtime.waitForInvocation(invocationId, {
        pollIntervalMs: 50,
        waitTimeoutMs: 30_000,
      });
      expect(result.text).toBe('Fine.');
      const next = await runtime.enqueue({
        scope: 'settled-throwing',
        prompt: 'Keep working',
      });
      await runtime.waitForInvocation(next.invocationId, {
        pollIntervalMs: 50,
        waitTimeoutMs: 30_000,
      });
      await waitFor(async () => callbackCount === 2);
    } finally {
      await worker.stop();
    }
  });

  it('fires with failed when the final attempt lease expires', async () => {
    const settled: InvocationRecord[] = [];
    const runtime = defineRuntime({
      db: handle,
      model: textModel('Never runs.'),
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      onInvocationSettled: (invocation) => {
        settled.push(invocation);
      },
    });
    const { invocationId } = await runtime.enqueue({
      scope: 'settled-lease-expired',
      prompt: 'Claimed by a worker that dies',
      maxAttempts: 1,
    });
    // Simulate a worker that claims the invocation and dies mid-run.
    const { claimed } = await claimInvocations(handle.db, 'worker-doomed', {
      leaseTimeoutMs: 400,
      maxBatchSize: 1,
    });
    expect(claimed.map((row) => String(row.id))).toContain(invocationId);
    await sleep(700);
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      await waitFor(async () => settled.length === 1);
      expect(settled[0]).toMatchObject({
        id: invocationId,
        status: 'failed',
        lastErrorCode: 'lease_expired',
      });
    } finally {
      await worker.stop();
    }
  });

  it('fires settled even when the worker onSucceeded callback throws', async () => {
    const settled: InvocationRecord[] = [];
    const runtime = defineRuntime({
      db: handle,
      model: textModel('Done.'),
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      onInvocationSettled: (invocation) => {
        settled.push(invocation);
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
      onSucceeded: () => {
        throw new Error('legacy hook bug');
      },
    });
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'settled-legacy-success-throws',
        prompt: 'Say hi',
      });
      await waitFor(async () => settled.length === 1);
      expect(settled[0]).toMatchObject({
        id: invocationId,
        status: 'succeeded',
        resultText: 'Done.',
      });
      const record = await runtime.getInvocation(invocationId);
      expect(record?.status).toBe('succeeded');
    } finally {
      await worker.stop();
    }
  });

  it('fires settled even when the worker onFailed callback throws', async () => {
    const settled: InvocationRecord[] = [];
    const runtime = defineRuntime({
      db: handle,
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          await sleep(300);
          throw new Error('provider exploded');
        },
      }),
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      onInvocationSettled: (invocation) => {
        settled.push(invocation);
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
      retryDelayMs: 10,
      onFailed: () => {
        throw new Error('legacy hook bug');
      },
    });
    const { invocationId } = await runtime.enqueue({
      scope: 'settled-legacy-failure-throws',
      prompt: 'Boom',
      maxAttempts: 1,
    });
    await waitFor(
      async () =>
        (await runtime.getInvocation(invocationId))?.status === 'running',
    );
    // Attach the stop handler before the legacy hook can throw: its throw
    // rejecting the worker loop is pre-existing behavior under test here
    // only for the settled notification surviving it.
    const stopped = worker.stop().catch(() => 'loop rejected');
    await waitFor(async () => settled.length === 1);
    expect(settled[0]).toMatchObject({
      id: invocationId,
      status: 'failed',
      lastErrorCode: 'execution_failed',
    });
    await stopped;
  });

  it('notifies for an invocation exhausted by a claim while another notification is blocked', async () => {
    const settled: InvocationRecord[] = [];
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const runtime = defineRuntime({
      db: handle,
      model: textModel('Never runs.'),
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      onInvocationSettled: async (invocation) => {
        settled.push(invocation);
        if (settled.length === 1) {
          await gate;
        }
      },
    });
    const first = await runtime.enqueue({
      scope: 'settled-claim-race',
      prompt: 'First to expire',
      maxAttempts: 1,
    });
    const doomedFirst = await claimInvocations(handle.db, 'worker-doomed', {
      leaseTimeoutMs: 300,
      maxBatchSize: 1,
    });
    expect(doomedFirst.claimed.map((row) => String(row.id))).toContain(
      first.invocationId,
    );
    await sleep(500);
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      // The worker's first claim exhausts the first invocation and then
      // blocks inside its settled notification.
      await waitFor(async () => settled.length === 1);
      const second = await runtime.enqueue({
        scope: 'settled-claim-race',
        prompt: 'Expires during the blocked notification',
        maxAttempts: 1,
      });
      await claimInvocations(handle.db, 'worker-doomed', {
        leaseTimeoutMs: 300,
        maxBatchSize: 1,
      });
      await sleep(500);
      releaseGate();
      await waitFor(async () => settled.length === 2);
      await sleep(200);
      expect(settled).toHaveLength(2);
      expect(settled[0]).toMatchObject({
        id: first.invocationId,
        status: 'failed',
        lastErrorCode: 'lease_expired',
      });
      expect(settled[1]).toMatchObject({
        id: second.invocationId,
        status: 'failed',
        lastErrorCode: 'lease_expired',
      });
    } finally {
      releaseGate();
      await worker.stop();
    }
  });

  it('keeps the claimed lease alive while an exhausted callback is blocked', async () => {
    const expired = await enqueueInvocation(handle.db, {
      scope: 'settled-guard-alive',
      prompt: 'Expired work',
      maxAttempts: 1,
    });
    await claimInvocations(handle.db, 'dead', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    await handle.pool.query(
      `update agent_runtime.invocations set lease_expires_at = now() - interval '1 second' where id = $1`,
      [expired.invocationId],
    );
    const pending = await enqueueInvocation(handle.db, {
      scope: 'settled-guard-alive',
      prompt: 'Only A should execute',
    });
    const settledA: InvocationRecord[] = [];
    const settledB: InvocationRecord[] = [];
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const runtimeA = defineRuntime({
      db: handle,
      model: textModel('A completed.'),
      onInvocationSettled: async (record) => {
        settledA.push(record);
        if (record.id === expired.invocationId) await gate;
      },
    });
    const runtimeB = defineRuntime({
      db: handle,
      model: textModel('B must not execute.'),
      onInvocationSettled: (record) => {
        settledB.push(record);
      },
    });
    const invokeA = vi.spyOn(runtimeA.engine, 'invoke');
    const invokeB = vi.spyOn(runtimeB.engine, 'invoke');
    const workerA = runWorker({
      runtime: runtimeA,
      db: handle,
      workerId: 'guard-alive-A',
      leaseTimeoutMs: 300,
      heartbeatIntervalMs: 25,
      pollIdleMs: 10,
      pollActiveMs: 10,
    });
    let workerB: ReturnType<typeof runWorker> | undefined;
    try {
      await waitFor(async () => settledA.length === 1);
      expect(
        await getInvocationRowById(handle.db, pending.invocationId),
      ).toMatchObject({
        status: 'running',
        claimedBy: 'guard-alive-A',
        attemptCount: 1,
      });
      workerB = runWorker({
        runtime: runtimeB,
        db: handle,
        workerId: 'guard-alive-B',
        leaseTimeoutMs: 300,
        heartbeatIntervalMs: 25,
        pollIdleMs: 10,
        pollActiveMs: 10,
      });
      await sleep(1_000);
      expect(
        await getInvocationRowById(handle.db, pending.invocationId),
      ).toMatchObject({
        status: 'running',
        claimedBy: 'guard-alive-A',
        attemptCount: 1,
      });
      expect(invokeA).not.toHaveBeenCalled();
      expect(invokeB).not.toHaveBeenCalled();
      expect(settledB).toEqual([]);
      releaseGate();
      await waitFor(async () => settledA.length === 2);
      expect(invokeA).toHaveBeenCalledTimes(1);
      expect(invokeB).not.toHaveBeenCalled();
      expect(settledA).toMatchObject([
        {
          id: expired.invocationId,
          status: 'failed',
          lastErrorCode: 'lease_expired',
        },
        { id: pending.invocationId, status: 'succeeded', attemptCount: 1 },
      ]);
      expect(settledB).toEqual([]);
    } finally {
      releaseGate();
      await Promise.all([workerA.stop(), workerB?.stop()]);
    }
  });

  it('does not dispatch claimed work taken over during a blocked exhausted callback', async () => {
    const expired = await enqueueInvocation(handle.db, {
      scope: 'settled-guard-lost',
      prompt: 'Expired work',
      maxAttempts: 1,
    });
    await claimInvocations(handle.db, 'dead', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
    });
    await handle.pool.query(
      `update agent_runtime.invocations set lease_expires_at = now() - interval '1 second' where id = $1`,
      [expired.invocationId],
    );
    const pending = await enqueueInvocation(handle.db, {
      scope: 'settled-guard-lost',
      prompt: 'Taken over before dispatch',
    });
    const settled: InvocationRecord[] = [];
    let releaseGate!: () => void;
    let callbackReturned = false;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const runtime = defineRuntime({
      db: handle,
      model: textModel('Must not execute.'),
      onInvocationSettled: async (record) => {
        settled.push(record);
        if (record.id === expired.invocationId) {
          await gate;
          callbackReturned = true;
        }
      },
    });
    const invoke = vi.spyOn(runtime.engine, 'invoke');
    const worker = runWorker({
      runtime,
      db: handle,
      workerId: 'guard-lost-A',
      leaseTimeoutMs: 30_000,
      // Require the pre-dispatch beat to detect takeover before the interval fires.
      heartbeatIntervalMs: 60_000,
      pollIdleMs: 10,
      pollActiveMs: 10,
    });
    try {
      await waitFor(async () => settled.length === 1);
      const original = await getInvocationRowById(
        handle.db,
        pending.invocationId,
      );
      expect(original).toMatchObject({
        status: 'running',
        claimedBy: 'guard-lost-A',
        attemptCount: 1,
      });
      const takeover = await handle.db.transaction(async (tx) => {
        await tx.execute(sql`
          update agent_runtime.invocations
          set lease_expires_at = now() - interval '1 second'
          where id = ${Number(pending.invocationId)}
        `);
        return claimInvocations(tx, 'guard-lost-B', {
          leaseTimeoutMs: 30_000,
          maxBatchSize: 1,
        });
      });
      expect(takeover.claimed).toMatchObject([
        {
          id: Number(pending.invocationId),
          claimedBy: 'guard-lost-B',
          attemptCount: 2,
        },
      ]);
      expect(takeover.claimed[0].activeRunId).not.toBe(original?.activeRunId);
      releaseGate();
      await waitFor(async () => callbackReturned);
      await sleep(200);
      expect(invoke).not.toHaveBeenCalled();
      expect(
        await getInvocationRowById(handle.db, pending.invocationId),
      ).toMatchObject({
        status: 'running',
        claimedBy: 'guard-lost-B',
        attemptCount: 2,
        activeRunId: takeover.claimed[0].activeRunId,
      });
      expect(settled).toMatchObject([
        {
          id: expired.invocationId,
          status: 'failed',
          lastErrorCode: 'lease_expired',
        },
      ]);
    } finally {
      releaseGate();
      await worker.stop();
    }
  });
});

describe('caller run identity', () => {
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

  function finish(content: unknown[]) {
    return {
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
    };
  }

  it('rejects a caller runId for durable enqueue and invoke', async () => {
    const runtime = defineRuntime({
      db: handle,
      model: new MockLanguageModelV4({
        doGenerate: async () => finish([{ type: 'text', text: 'unused' }]),
      }),
    });
    await expect(
      runtime.enqueue({
        scope: 'caller-run-id',
        prompt: 'Hi',
        runId: 'host-1',
      }),
    ).rejects.toMatchObject({
      diagnostics: { code: 'caller_run_id_in_durable_mode' },
    });
    await expect(
      runtime.invoke({
        scope: 'caller-run-id',
        prompt: 'Hi',
        runId: 'host-1',
      }),
    ).rejects.toMatchObject({
      diagnostics: { code: 'caller_run_id_in_durable_mode' },
    });
    const rows = await handle.db.execute(
      sql`select count(*)::int as n from agent_runtime.invocations where scope = 'caller-run-id'`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it('refuses a caller runId on a multi-row claim', async () => {
    await expect(
      claimInvocations(handle.db, 'worker-x', {
        leaseTimeoutMs: 1_000,
        maxBatchSize: 2,
        runId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toThrow(/maxBatchSize of 1/);
  });

  it('mints per-attempt runIds with the generateRunId factory', async () => {
    const minted: string[] = [];
    const openedRunIds: string[] = [];
    const fakeMcpClient: McpToolClient = {
      async open(input) {
        openedRunIds.push(input.runId);
        return {
          async callTool() {
            return JSON.stringify([{ type: 'text', text: 'note body' }]);
          },
          async close() {},
        };
      },
    };
    let generations = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        generations++;
        if (generations === 1) {
          throw new Error('first attempt fails');
        }
        const promptText = JSON.stringify(options.prompt);
        if (promptText.includes('note body')) {
          return finish([{ type: 'text', text: 'Recovered.' }]);
        }
        return finish([
          {
            type: 'tool-call',
            toolCallId: 'call-note',
            toolName: 'notes__get',
            input: '{}',
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
          name: 'notes__get',
          description: 'Get a note',
          inputSchema: z.object({}),
        },
      ],
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      generateRunId: () => {
        const id = `00000000-0000-4000-8000-${String(minted.length + 1).padStart(12, '0')}`;
        minted.push(id);
        return id;
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
      retryDelayMs: 50,
    });
    try {
      const first = await runtime.enqueue({
        scope: 'caller-run-id-factory',
        prompt: 'Get the note',
        maxAttempts: 2,
      });
      const result = await runtime.waitForInvocation(first.invocationId, {
        pollIntervalMs: 50,
        waitTimeoutMs: 30_000,
      });
      expect(result.text).toBe('Recovered.');
      const firstRow = await getInvocationRowById(
        handle.db,
        first.invocationId,
      );
      expect(firstRow?.attemptCount).toBe(2);
      expect(firstRow?.activeRunId).toBeTruthy();
      expect(minted).toContain(firstRow?.activeRunId);
      // The MCP session for the executing attempt carried that attempt's id.
      expect(openedRunIds).toEqual([firstRow?.activeRunId]);

      const second = await runtime.enqueue({
        scope: 'caller-run-id-factory',
        prompt: 'Get the note',
        maxAttempts: 1,
      });
      await runtime.waitForInvocation(second.invocationId, {
        pollIntervalMs: 50,
        waitTimeoutMs: 30_000,
      });
      const secondRow = await getInvocationRowById(
        handle.db,
        second.invocationId,
      );
      expect(secondRow?.activeRunId).toBeTruthy();
      expect(minted).toContain(secondRow?.activeRunId);
      expect(secondRow?.activeRunId).not.toBe(firstRow?.activeRunId);
    } finally {
      await worker.stop();
    }
  });

  it('fails the worker loudly when generateRunId returns a non-UUID', async () => {
    const runtime = defineRuntime({
      db: handle,
      model: new MockLanguageModelV4({
        doGenerate: async () => finish([{ type: 'text', text: 'unused' }]),
      }),
      generateRunId: () => 'not-a-uuid',
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    await expect(worker.stop()).rejects.toThrow(
      /generateRunId must return a UUID/,
    );
  });

  it('keeps a generateRunId failure observable through a delayed stop()', async () => {
    const runtime = defineRuntime({
      db: handle,
      model: new MockLanguageModelV4({
        doGenerate: async () => finish([{ type: 'text', text: 'unused' }]),
      }),
      generateRunId: () => 'not-a-uuid',
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    // The loop rejects on its first turn, long before this stop() call.
    // If that rejection were left unhandled in the meantime, Node would
    // terminate the process instead of letting stop() observe it.
    await sleep(250);
    await expect(worker.stop()).rejects.toThrow(
      /generateRunId must return a UUID/,
    );
  });

  it('fails loudly when generateRunId throws', async () => {
    const runtime = defineRuntime({
      db: handle,
      model: new MockLanguageModelV4({
        doGenerate: async () => finish([{ type: 'text', text: 'unused' }]),
      }),
      generateRunId: () => {
        throw new Error('factory boom');
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    await expect(worker.stop()).rejects.toThrow(/factory boom/);
  });

  it("gives an approval rerun the factory's next runId", async () => {
    const minted: string[] = [];
    const openedRunIds: string[] = [];
    const refundClient: McpToolClient = {
      async open(input) {
        openedRunIds.push(input.runId);
        return {
          async callTool() {
            return JSON.stringify([{ type: 'text', text: 'Refund completed' }]);
          },
          async close() {},
        };
      },
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        if (promptText.includes('Refund completed')) {
          return finish([{ type: 'text', text: 'Refund done.' }]);
        }
        return finish([
          {
            type: 'tool-call',
            toolCallId: 'call-refund',
            toolName: 'billing__refund',
            input: JSON.stringify({ amount: 100 }),
          },
        ]);
      },
    });
    const runtime = defineRuntime({
      db: handle,
      model,
      mcpClient: refundClient,
      tools: [
        {
          name: 'billing__refund',
          description: 'Refund a payment',
          inputSchema: z.object({ amount: z.number() }),
        },
      ],
      policies: { requireApproval: ['billing__refund'] },
      loadSystemPrompt: async () => 'You are helpful.',
      loadHistory: async () => [],
      generateRunId: () => {
        const id = `10000000-0000-4000-8000-${String(minted.length + 1).padStart(12, '0')}`;
        minted.push(id);
        return id;
      },
    });
    const worker = runWorker({
      runtime,
      db: handle,
      pollIdleMs: 50,
      pollActiveMs: 10,
    });
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'caller-run-id-approval',
        prompt: 'Refund this customer',
      });
      await waitFor(async () => {
        const record = await runtime.getInvocation(invocationId);
        return record?.status === 'awaiting_approval';
      });
      const parked = await getInvocationRowById(handle.db, invocationId);
      const parkedRunId = parked?.activeRunId ?? '';
      expect(parkedRunId).not.toBe('');
      expect(minted).toContain(parkedRunId);

      await runtime.approveInvocation(invocationId);
      const result = await runtime.waitForInvocation(invocationId, {
        pollIntervalMs: 50,
        waitTimeoutMs: 30_000,
      });
      expect(result.text).toBe('Refund done.');
      const settled = await getInvocationRowById(handle.db, invocationId);
      const settledRunId = settled?.activeRunId ?? '';
      expect(settledRunId).not.toBe('');
      expect(minted).toContain(settledRunId);
      expect(settledRunId).not.toBe(parkedRunId);
      // The rerun ran under an ID minted after the parked attempt's ID:
      // the factory's next value, not a reuse of the parked one.
      expect(minted.indexOf(settledRunId)).toBeGreaterThan(
        minted.indexOf(parkedRunId),
      );
      expect(openedRunIds).toEqual([settledRunId]);
    } finally {
      await worker.stop();
    }
  });

  it('fences heartbeat and completion on a factory-supplied runId', async () => {
    const runId = '33333333-3333-4333-8333-333333333333';
    const wrongRunId = '44444444-4444-4444-8444-444444444444';
    await enqueueInvocation(handle.db, {
      scope: 'caller-run-id-fencing',
      prompt: 'Hi',
      maxAttempts: 1,
    });
    const { claimed } = await claimInvocations(handle.db, 'worker-x', {
      leaseTimeoutMs: 30_000,
      maxBatchSize: 1,
      runId,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.activeRunId).toBe(runId);
    const rowId = claimed[0]!.id;
    await expect(
      heartbeatInvocation(handle.db, rowId, 'worker-x', wrongRunId, 30_000),
    ).resolves.toBe(false);
    await expect(
      heartbeatInvocation(handle.db, rowId, 'worker-x', runId, 30_000),
    ).resolves.toBe(true);
    await expect(
      markInvocationSucceeded(handle.db, rowId, 'worker-x', wrongRunId, {
        resultText: 'nope',
      }),
    ).resolves.toBe(false);
    await expect(
      markInvocationSucceeded(handle.db, rowId, 'worker-x', runId, {
        resultText: 'done',
      }),
    ).resolves.toBe(true);
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

  function setup(onToolCallAudit?: ToolCallAuditSink) {
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
      onToolCallAudit,
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

  it('fails instead of accepting a completion that did not update its claimed row', async () => {
    const { runtime, worker, executed } = setup(async (event) => {
      if (event.phase === 'started')
        await handle.pool.query(
          "update agent_runtime.tool_call_audits set metadata = jsonb_set(metadata, '{dispatchId}', '\"superseded\"') where invocation_id=$1",
          [event.invocationId],
        );
    });
    try {
      const { invocationId } = await runtime.enqueue({
        scope: 'lost-audit',
        prompt: 'Find the roadmap note',
        maxAttempts: 1,
      });
      await waitFor(
        async () =>
          (await runtime.getInvocation(invocationId))?.status === 'failed',
      );
      expect((await runtime.getInvocation(invocationId))?.lastErrorCode).toBe(
        'audit_persistence_failed',
      );
      expect(executed.search).toBe(1);
      expect((await auditsFor(invocationId))[0]?.status).toBe('started');
    } finally {
      await worker.stop();
    }
  });

  it('isolates parallel tool events across workers sharing one runtime', async () => {
    const listeners = new Set<(event: ToolCallAuditEvent) => Promise<void>>();
    const emit = async (event: ToolCallAuditEvent) => {
      await Promise.all([...listeners].map((listener) => listener(event)));
    };
    let entered = 0;
    let release!: () => void;
    const bothRunning = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      [RUNTIME_INTERNALS]: {
        onPolicyDecision: () => () => {},
        onToolCallAudit(
          listener: (event: ToolCallAuditEvent) => Promise<void>,
        ) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      engine: {
        async invoke(
          input: import('../contracts/runtime.js').RuntimeInvocationInput,
        ) {
          if (++entered === 2) release();
          await bothRunning;
          await Promise.all(
            ['one', 'two'].map(async (toolName) => {
              const event = {
                scope: input.scope,
                invocationId: input.invocationId,
                runId: input.runId,
                toolName,
                dispatchId: `${input.runId}:${toolName}`,
                idempotencyKey: `${input.invocationId}:${toolName}`,
                input: { toolName },
              };
              await emit({
                ...event,
                phase: 'started',
                runId: '00000000-0000-4000-8000-000000000000',
              });
              await emit({ ...event, phase: 'started' });
              await emit({ ...event, phase: 'succeeded' });
            }),
          );
          return {
            invocationId: input.invocationId,
            runId: input.runId,
            text: 'Done',
            messages: [],
            usage: emptyInvocationUsage(),
          };
        },
      },
    };
    const ids = await Promise.all(
      ['a', 'b'].map((scope) =>
        enqueueInvocation(handle.db, {
          scope,
          prompt: 'parallel',
          maxAttempts: 1,
        }),
      ),
    );
    const workers = [0, 1].map(() =>
      runWorker({ runtime, db: handle, pollIdleMs: 10, pollActiveMs: 10 }),
    );
    try {
      for (const { invocationId } of ids) {
        await waitFor(
          async () =>
            (await getInvocationRowById(handle.db, invocationId))?.status ===
            'succeeded',
        );
        const invocation = await getInvocationRowById(handle.db, invocationId);
        const audits = await auditsFor(invocationId);
        expect(audits).toHaveLength(2);
        expect(audits.map((row) => row.tool_name).sort()).toEqual([
          'one',
          'two',
        ]);
        for (const row of audits)
          expect(row).toMatchObject({
            scope: invocation!.scope,
            run_id: invocation!.activeRunId,
            status: 'succeeded',
          });
      }
    } finally {
      release();
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  });

  it('fails a completion without a matching started event', async () => {
    let listener: ((event: ToolCallAuditEvent) => Promise<void>) | undefined;
    const { invocationId } = await enqueueInvocation(handle.db, {
      scope: 'missing-start',
      prompt: 'test',
      maxAttempts: 1,
    });
    const worker = runWorker({
      db: handle,
      pollIdleMs: 10,
      runtime: {
        [RUNTIME_INTERNALS]: {
          onPolicyDecision: () => () => {},
          onToolCallAudit(callback) {
            listener = callback;
            return () => {
              listener = undefined;
            };
          },
        },
        engine: {
          async invoke(input) {
            await listener!({
              ...input,
              phase: 'succeeded',
              toolName: 'test',
              dispatchId: 'missing',
              idempotencyKey: 'missing',
              input: {},
            });
            return {
              invocationId: input.invocationId,
              runId: input.runId,
              text: 'must not succeed',
              messages: [],
              usage: emptyInvocationUsage(),
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
      expect(
        (await getInvocationRowById(handle.db, invocationId))?.lastErrorMessage,
      ).toContain('no started event');
      expect(await auditsFor(invocationId)).toEqual([]);
    } finally {
      await worker.stop();
    }
  });

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
