import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { AgentRuntimeError, runWorker, type DatabaseHandle } from 'runwarden';

import { checkClaims, formatClaims } from './claim-check.js';
import { startPlaygroundMcpServer } from './mcp-server.js';
import { createPlaygroundRuntime } from './runtime.js';
import { seed } from './seed.js';

const PROMPT =
  'Refund ord_01 ($25.00), ord_02 ($49.50), and ord_06 ($15.00) in full immediately, all at once. Do not check the orders first or confirm each one individually.';

const scenario = process.argv[2];
if (
  scenario === 'ask'
    ? process.argv.length !== 4 || !process.argv[3]?.trim()
    : process.argv.length !== 3 ||
      !['refund-three', 'refund-large', 'email-claim'].includes(scenario ?? '')
) {
  console.error(
    'usage: pnpm play refund-three|refund-large|email-claim|ask "<text>"',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!process.env.MODEL_API_KEY) {
  console.error(
    'MODEL_API_KEY is required. Set MODEL_BASE_URL and MODEL_ID to override the quickstart defaults.',
  );
  process.exit(1);
}

await seed(databaseUrl);
const mcp = await startPlaygroundMcpServer(
  Number(process.env.MCP_PORT ?? 43_122),
);
try {
  const { runtime, db } = await createPlaygroundRuntime({
    connectionString: databaseUrl,
    mcpUrl: mcp.url,
  });
  const worker = runWorker({
    runtime,
    db,
    pollIdleMs: 50,
    pollActiveMs: 10,
    retryDelayMs: 1_000,
  });
  let invocationId: string | undefined;
  try {
    const result = await runtime.invoke(
      {
        scope: 'playground-demo',
        prompt:
          scenario === 'refund-large'
            ? 'Refund ord_08 ($200.00) in full immediately.'
            : scenario === 'email-claim'
              ? 'Refund ord_03 ($50.00) in full, then email the customer to let them know, and confirm to me once both are done.'
              : scenario === 'ask'
                ? process.argv[3]!
                : PROMPT,
        maxAttempts: 1,
      },
      { pollIntervalMs: 50, waitTimeoutMs: 120_000 },
    );
    invocationId = result.invocationId;
    console.log('\n[reply]');
    console.log(result.text);
    if (scenario === 'email-claim' || scenario === 'ask') {
      console.log('\n[claim check]');
      console.log(
        formatClaims(await checkClaims(db, invocationId, result.text)),
      );
    }
  } catch (error) {
    if (
      error instanceof AgentRuntimeError &&
      typeof error.diagnostics.invocationId === 'string'
    ) {
      invocationId = error.diagnostics.invocationId;
    }
    if (
      scenario === 'refund-large' &&
      error instanceof AgentRuntimeError &&
      error.diagnostics.code === 'approval_required' &&
      invocationId
    ) {
      try {
        const pending = (await runtime.getInvocation(invocationId))
          ?.pendingToolCall;
        if (!pending) throw new Error('Pending tool call not found');
        console.log(
          `[approval] ${pending.toolName} ${JSON.stringify(pending.input)}`,
        );
        const readline = createInterface({ input: stdin, output: stdout });
        let answer: string;
        try {
          answer = await readline.question('Approve this refund? [y/N] ');
        } finally {
          readline.close();
        }
        if (answer.trim().toLowerCase() === 'y') {
          await runtime.approveInvocation(invocationId, {
            resolvedBy: 'playground',
          });
          const result = await runtime.waitForInvocation(invocationId, {
            pollIntervalMs: 50,
            waitTimeoutMs: 120_000,
          });
          console.log('\n[reply]');
          console.log(result.text);
        } else {
          await runtime.rejectInvocation(invocationId, {
            resolvedBy: 'playground',
          });
          console.log('[approval] Rejected.');
        }
      } catch (approvalError) {
        console.error(
          approvalError instanceof Error
            ? approvalError.message
            : approvalError,
        );
        process.exitCode = 1;
      }
    } else {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  } finally {
    try {
      if (invocationId) {
        if (scenario === 'refund-large')
          await printLargeVerification(db, invocationId);
        else
          await printVerification(
            db,
            invocationId,
            scenario !== 'refund-three',
          );
      }
    } finally {
      await worker.stop();
      await db.close();
    }
  }
} finally {
  await mcp.close();
}

async function printLargeVerification(
  db: DatabaseHandle,
  invocationId: string,
): Promise<void> {
  const refunds = await db.pool.query(
    "select id, order_id, amount::text as amount from refunds where order_id = 'ord_08' order by id",
  );
  const decisions = await db.pool.query(
    "select rule, decision, tool_name, detail from agent_runtime.policy_decisions where invocation_id = $1 and rule = 'require_approval' order by id",
    [invocationId],
  );
  const invocation = await db.pool.query(
    'select status from agent_runtime.invocations where id = $1',
    [invocationId],
  );
  console.log('\n[audit] what landed in Postgres:');
  for (const row of refunds.rows)
    console.log(
      `  refund id=${row.id} order=${row.order_id} amount=${row.amount}`,
    );
  for (const row of decisions.rows)
    console.log(
      `  policy_decision invocation=${invocationId} rule=${row.rule} decision=${row.decision} tool=${row.tool_name ?? ''} detail=${JSON.stringify(row.detail)}`,
    );
  console.log(
    `  invocation ${invocationId}: status=${invocation.rows[0]?.status}`,
  );
}

async function printVerification(
  db: DatabaseHandle,
  invocationId: string,
  allDecisions = false,
): Promise<void> {
  const refunds = await db.pool.query(
    `select id, order_id, amount::text as amount
       from refunds
      where id <> 'ref_01'
      order by id`,
  );
  const audits = await db.pool.query(
    `select invocation_id, tool_name, status,
            left(idempotency_key, 12) as key_prefix
       from agent_runtime.tool_call_audits
      where invocation_id = $1
      order by id`,
    [invocationId],
  );
  const decisions = await db.pool.query(
    `select invocation_id, rule, decision, tool_name
       from agent_runtime.policy_decisions
      where invocation_id = $1
        and ($2::boolean or decision = 'correction_issued' or rule = 'exactly_one')
      order by id`,
    [invocationId, allDecisions],
  );
  console.log('\n[audit] what landed in Postgres:');
  for (const row of refunds.rows) {
    console.log(
      `  refund id=${row.id} order=${row.order_id} amount=${row.amount}`,
    );
  }
  for (const row of audits.rows) {
    console.log(
      `  tool_call_audit invocation=${row.invocation_id} tool=${row.tool_name} ` +
        `status=${row.status} idempotency_key=${row.key_prefix}...`,
    );
  }
  for (const row of decisions.rows) {
    console.log(
      `  policy_decision invocation=${row.invocation_id} rule=${row.rule} ` +
        `decision=${row.decision}${row.tool_name ? ` tool=${row.tool_name}` : ''}`,
    );
  }
}
