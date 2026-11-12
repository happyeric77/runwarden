// Fake model (MockLanguageModelV4), not a live provider run.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import EmbeddedPostgres from 'embedded-postgres';
import { AgentRuntimeError, runWorker } from 'runwarden';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startFeedServer } from './feed.js';
import { startPlaygroundMcpServer } from './mcp-server.js';
import { createPlaygroundRuntime } from './runtime.js';
import { seed } from './seed.js';

const port = 29_000 + Math.floor(Math.random() * 3_000);
const connectionString = `postgres://postgres:password@localhost:${port}/gp_approval`;
const pg = new EmbeddedPostgres({
  databaseDir: path.join(tmpdir(), `gp-approval-${randomUUID()}`),
  user: 'postgres',
  password: 'password',
  port,
  persistent: true,
  postgresFlags: process.platform === 'win32' ? [] : ['-k', tmpdir()],
});
const previousUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('gp_approval');
  process.env.DATABASE_URL = connectionString;
});
afterAll(async () => {
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
  await pg.stop();
});

async function runCase(
  toolName: string,
  input: object,
  action: 'approve' | 'reject' | 'direct' | 'delete',
) {
  await seed(connectionString);
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const completed = options.prompt.some(
        (message) => message.role === 'tool',
      );
      return {
        content: (completed
          ? [{ type: 'text', text: 'Done.' }]
          : [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName,
                input: JSON.stringify(input),
              },
            ]) as never,
        finishReason: { unified: 'stop' as const, raw: 'stop' },
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
    },
  });
  const mcp = await startPlaygroundMcpServer(0);
  const { runtime, db } = await createPlaygroundRuntime({
    connectionString,
    mcpUrl: mcp.url,
    model,
  });
  const worker = runWorker({ runtime, db, pollIdleMs: 20, pollActiveMs: 10 });
  const feed = await startFeedServer(0);
  try {
    let id: string;
    try {
      const result = await runtime.invoke(
        {
          scope: 'approval-test',
          prompt: 'Perform the requested action.',
          maxAttempts: 1,
        },
        { pollIntervalMs: 20, waitTimeoutMs: 30_000 },
      );
      expect(action).toBe('direct');
      id = result.invocationId;
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeError);
      const diagnostics = (error as AgentRuntimeError).diagnostics;
      expect(diagnostics.code).toBe('approval_required');
      id = diagnostics.invocationId as string;
      expect((await runtime.getInvocation(id))?.status).toBe(
        'awaiting_approval',
      );
      const refunds = await db.pool.query(
        "select * from refunds where order_id = 'ord_08'",
      );
      expect(refunds.rowCount).toBe(0);
      const data = (await (await fetch(`${feed.url}/api/events`)).json()) as {
        stats: { awaitingApproval: number };
        pendingApprovals: Array<{
          invocationId: string;
          tool: string;
          input: unknown;
          createdAt: string;
        }>;
      };
      expect(data.stats.awaitingApproval).toBe(1);
      expect(data.pendingApprovals).toContainEqual({
        invocationId: id,
        tool: toolName,
        input,
        createdAt: expect.any(String),
      });
      if (action === 'approve') {
        await runtime.approveInvocation(id, { resolvedBy: 'playground' });
        await runtime.waitForInvocation(id, {
          pollIntervalMs: 20,
          waitTimeoutMs: 30_000,
        });
      } else {
        await runtime.rejectInvocation(id, { resolvedBy: 'playground' });
      }
      const after = (await (await fetch(`${feed.url}/api/events`)).json()) as {
        pendingApprovals: unknown[];
      };
      expect(after.pendingApprovals).toEqual([]);
    }
    const decisions = await db.pool.query<{
      decision: string;
      detail: unknown;
    }>(
      "select decision, detail from agent_runtime.policy_decisions where invocation_id = $1 and rule = 'require_approval' order by id",
      [id],
    );
    const refunds = await db.pool.query<{ amount: string }>(
      'select amount::text as amount from refunds where order_id = $1',
      [(input as { orderId?: string }).orderId ?? 'ord_08'],
    );
    if (action === 'approve') {
      expect(refunds.rows).toEqual([{ amount: '200.00' }]);
      expect(decisions.rows.map((row) => row.decision)).toEqual([
        'approval_requested',
        'approved',
        'allow',
      ]);
      expect(decisions.rows[2]?.detail).toMatchObject({ viaApproval: true });
      expect((await runtime.getInvocation(id))?.status).toBe('succeeded');
    } else if (action === 'direct') {
      expect(refunds.rows).toEqual([{ amount: '50.00' }]);
      expect(decisions.rows.map((row) => row.decision)).not.toContain(
        'approval_requested',
      );
    } else {
      expect(refunds.rowCount).toBe(0);
      expect(decisions.rows.map((row) => row.decision)).toContain(
        'approval_requested',
      );
      expect(decisions.rows.map((row) => row.decision)).toContain('rejected');
      expect((await runtime.getInvocation(id))?.status).toBe('cancelled');
    }
  } finally {
    await feed.close();
    await worker.stop();
    await db.close();
    await mcp.close();
  }
}

it('parks and approves a $200 refund (fake model)', () =>
  runCase('issue_refund', { orderId: 'ord_08', amount: 200 }, 'approve'));
it('rejects a parked $200 refund (fake model)', () =>
  runCase('issue_refund', { orderId: 'ord_08', amount: 200 }, 'reject'));
it('executes a $50 refund without approval (fake model)', () =>
  runCase('issue_refund', { orderId: 'ord_05', amount: 50 }, 'direct'));
it('parks customer deletion (fake model)', () =>
  runCase('delete_customer', { customerId: 'cus_01' }, 'delete'));
