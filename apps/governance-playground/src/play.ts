import { AgentRuntimeError, runWorker, type DatabaseHandle } from 'runwarden';

import { startPlaygroundMcpServer } from './mcp-server.js';
import { createPlaygroundRuntime } from './runtime.js';
import { seed } from './seed.js';

const PROMPT =
  'Please refund these three orders in full: ord_01, ord_02, ord_06.';

const scenario = process.argv[2];
if (process.argv.length !== 3 || scenario !== 'refund-three') {
  console.error('usage: pnpm play refund-three');
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
      { scope: 'playground-demo', prompt: PROMPT, maxAttempts: 1 },
      { pollIntervalMs: 50, waitTimeoutMs: 120_000 },
    );
    invocationId = result.invocationId;
    console.log('\n[reply]');
    console.log(result.text);
  } catch (error) {
    if (
      error instanceof AgentRuntimeError &&
      typeof error.diagnostics.invocationId === 'string'
    ) {
      invocationId = error.diagnostics.invocationId;
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    try {
      if (invocationId) await printVerification(db, invocationId);
    } finally {
      await worker.stop();
      await db.close();
    }
  }
} finally {
  await mcp.close();
}

async function printVerification(
  db: DatabaseHandle,
  invocationId: string,
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
        and (decision = 'correction_issued' or rule = 'exactly_one')
      order by id`,
    [invocationId],
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
