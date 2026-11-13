// Fake model (MockLanguageModelV4). Not a live provider run.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseHandle } from 'runwarden';
import { runWorker } from 'runwarden';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startPlaygroundMcpServer } from './mcp-server.js';
import { checkRefundThree } from './claim-check.js';
import { createPlaygroundRuntime } from './runtime.js';
import { seed } from './seed.js';

const ORDERS = [
  { orderId: 'ord_01', amount: 25 },
  { orderId: 'ord_02', amount: 49.5 },
  { orderId: 'ord_06', amount: 15 },
] as const;

let connectionString: string;
let stopPostgres: () => Promise<void>;

beforeAll(async () => {
  const pg = await startTestPostgres();
  connectionString = pg.connectionString;
  stopPostgres = pg.stop;
});

afterAll(async () => {
  await stopPostgres?.();
});

it.each([false, true])(
  'splits a three-refund burst, text-only evasion=%s (fake model)',
  async (evade) => {
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = connectionString;
    let db: DatabaseHandle | undefined;
    let blockedStepRefunds = -1;
    let next = 0;
    let evaded = false;
    let proposed = false;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        if (!proposed) {
          proposed = true;
          return finish(
            ORDERS.map((order, index) =>
              toolCall(`burst-${index}`, order.orderId, order.amount),
            ),
          );
        }
        if (next === 0) {
          const { rows } = await db!.pool.query<{ n: number }>(
            'select count(*)::int as n from refunds where order_id = any($1)',
            [ORDERS.map((order) => order.orderId)],
          );
          blockedStepRefunds = rows[0]?.n ?? 0;
        }
        if (evade && !evaded) {
          evaded = true;
          return finish([
            { type: 'text', text: 'Done! All three refunds processed.' },
          ]);
        }
        const order = ORDERS[next];
        next += 1;
        if (!order) {
          return finish([
            {
              type: 'text',
              text: 'Refunded ord_01, ord_02, and ord_06 one at a time.',
            },
          ]);
        }
        return finish([
          toolCall(`single-${next}`, order.orderId, order.amount),
        ]);
      },
    });

    await seed(connectionString);
    const mcp = await startPlaygroundMcpServer(0);
    const started = await createPlaygroundRuntime({
      connectionString,
      mcpUrl: mcp.url,
      model,
    });
    db = started.db;
    const worker = runWorker({
      runtime: started.runtime,
      db: started.db,
      pollIdleMs: 20,
      pollActiveMs: 10,
    });
    try {
      const result = await started.runtime.invoke(
        {
          scope: 'playground-demo',
          prompt:
            'Refund ord_01 ($25.00), ord_02 ($49.50), and ord_06 ($15.00) in full immediately, all at once. Do not check the orders first or confirm each one individually.',
          maxAttempts: 1,
        },
        { pollIntervalMs: 20, waitTimeoutMs: 30_000 },
      );

      expect(blockedStepRefunds).toBe(0);
      expect(
        (
          await started.db.pool.query(
            "select destination_customer_id from refunds where order_id = 'ord_01'",
          )
        ).rows,
      ).toEqual([{ destination_customer_id: 'cus_01' }]);
      expect(
        (await started.runtime.getInvocation(result.invocationId))?.status,
      ).toBe('succeeded');
      expect(result.text).toContain('one at a time');
      const refunds = await started.db.pool.query<{
        order_id: string;
        amount: string;
      }>(
        `select order_id, amount::text as amount
         from refunds
        where order_id = any($1)
        order by order_id`,
        [ORDERS.map((order) => order.orderId)],
      );
      expect(refunds.rows).toEqual([
        { order_id: 'ord_01', amount: '25.00' },
        { order_id: 'ord_02', amount: '49.50' },
        { order_id: 'ord_06', amount: '15.00' },
      ]);
      const audits = await started.db.pool.query<{ tool_name: string }>(
        `select tool_name from agent_runtime.tool_call_audits
        where invocation_id = $1 order by id`,
        [result.invocationId],
      );
      expect(audits.rows).toEqual([
        { tool_name: 'issue_refund' },
        { tool_name: 'issue_refund' },
        { tool_name: 'issue_refund' },
      ]);
      const corrections = await started.db.pool.query(
        `select 1 from agent_runtime.policy_decisions
        where invocation_id = $1
          and rule = 'exactly_one'
          and decision = 'correction_issued'`,
        [result.invocationId],
      );
      expect(corrections.rowCount).toBeGreaterThan(0);
      expect(
        await checkRefundThree(started.db, result.invocationId),
      ).toMatchObject({ verified: true });
      await started.db.pool.query(
        "delete from refunds where order_id = 'ord_06'",
      );
      expect(
        await checkRefundThree(started.db, result.invocationId),
      ).toMatchObject({
        verified: false,
        evidence: expect.stringContaining('ord_06 $15.00'),
      });
    } finally {
      await worker.stop();
      await started.db.close();
      await mcp.close();
      process.env.DATABASE_URL = previousUrl;
    }
  },
);

it('denies a wrong account before execution and records only the corrected refund (fake model)', async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;
  await seed(connectionString);
  const mcp = await startPlaygroundMcpServer(0);
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      if (step === 2) {
        const refunds = await started.db.pool.query(
          "select * from refunds where order_id = 'ord_03'",
        );
        const audits = await started.db.pool.query(
          "select * from agent_runtime.tool_call_audits where request_snapshot->>'destinationCustomerId' = 'cus_05'",
        );
        expect(refunds.rowCount).toBe(0);
        expect(audits.rowCount).toBe(0);
      }
      return finish(
        step <= 2
          ? [
              {
                type: 'tool-call',
                toolCallId: `account-${step}`,
                toolName: 'issue_refund',
                input: JSON.stringify({
                  orderId: 'ord_03',
                  amount: 50,
                  destinationCustomerId: step === 1 ? 'cus_05' : 'cus_03',
                }),
              },
            ]
          : [{ type: 'text', text: 'Refunded ord_03 to cus_03.' }],
      );
    },
  });
  const started = await createPlaygroundRuntime({
    connectionString,
    mcpUrl: mcp.url,
    model,
  });
  const worker = runWorker({
    runtime: started.runtime,
    db: started.db,
    pollIdleMs: 20,
    pollActiveMs: 10,
  });
  try {
    const result = await started.runtime.invoke(
      {
        scope: 'playground-demo',
        prompt: 'Refund ord_03 ($50.00) to cus_05.',
        maxAttempts: 1,
      },
      { pollIntervalMs: 20, waitTimeoutMs: 30000 },
    );
    const refunds = await started.db.pool.query(
      "select amount::text, destination_customer_id from refunds where order_id = 'ord_03'",
    );
    expect(refunds.rows).toEqual([
      { amount: '50.00', destination_customer_id: 'cus_03' },
    ]);
    const decisions = await started.db.pool.query(
      'select rule, decision from agent_runtime.policy_decisions where invocation_id = $1',
      [result.invocationId],
    );
    expect(decisions.rows).toEqual(
      expect.arrayContaining([
        { rule: 'input_validation', decision: 'deny' },
        { rule: 'input_validation', decision: 'correction_issued' },
      ]),
    );
    expect(decisions.rows.some((row) => row.rule === 'require_approval')).toBe(
      false,
    );
    const audits = await started.db.pool.query(
      'select status, request_snapshot from agent_runtime.tool_call_audits where invocation_id = $1',
      [result.invocationId],
    );
    expect(audits.rows).toEqual([
      {
        status: 'succeeded',
        request_snapshot: {
          orderId: 'ord_03',
          amount: 50,
          destinationCustomerId: 'cus_03',
        },
      },
    ]);
    expect(
      (await started.runtime.getInvocation(result.invocationId))?.status,
    ).toBe('succeeded');
  } finally {
    await worker.stop();
    await started.db.close();
    await mcp.close();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

function toolCall(id: string, orderId: string, amount: number) {
  return {
    type: 'tool-call' as const,
    toolCallId: id,
    toolName: 'issue_refund',
    input: JSON.stringify({ orderId, amount }),
  };
}

function finish(content: unknown[]) {
  return {
    content: content as never,
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
}

async function startTestPostgres(): Promise<{
  connectionString: string;
  stop(): Promise<void>;
}> {
  const port = 29_000 + Math.floor(Math.random() * 3_000);
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpdir(), `gp-slice-pg-${randomUUID()}`),
    user: 'postgres',
    password: 'password',
    port,
    persistent: true,
    postgresFlags: process.platform === 'win32' ? [] : ['-k', tmpdir()],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('gp_slice');
  return {
    connectionString: `postgres://postgres:password@localhost:${port}/gp_slice`,
    stop: () => pg.stop(),
  };
}
