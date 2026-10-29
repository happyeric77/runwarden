import { z } from 'zod';

import {
  AgentRuntimeError,
  createDb,
  defineRuntime,
  initDb,
  runWorker,
  type ToolDefinition,
} from '../../src/index';
import { startQuickstartMcpServer } from './mcp-server';

const notesSearch: ToolDefinition = {
  name: 'notes__search',
  description: 'Search the notes collection by keyword.',
  inputSchema: z.object({ query: z.string() }),
  validateInput: (input) => {
    const query = (input as { query?: unknown }).query;
    return typeof query === 'string' && query.trim().length > 0
      ? { ok: true }
      : {
          ok: false,
          correction:
            'The search query was blank. Retry with a concrete keyword, for example "roadmap".',
        };
  },
};

const billingRefund: ToolDefinition = {
  name: 'billing__refund',
  description: 'Refund a charge to the original payment method.',
  inputSchema: z.object({
    amountCents: z.number().int().positive(),
    reason: z.string().min(1),
  }),
};

const modelKey = process.env.MODEL_API_KEY;
if (!modelKey) {
  console.error(
    '[quickstart] Set MODEL_API_KEY first — any OpenAI-compatible endpoint ' +
      'works; for a local model server, any non-empty value. ' +
      'See examples/quickstart/README.md.',
  );
  process.exit(1);
}

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://postgres:password@localhost:54330/runwarden_quickstart';

const mcp = await startQuickstartMcpServer(43_121);
console.log(`[quickstart] MCP tool server at ${mcp.url}`);

const db = createDb(connectionString);
try {
  await initDb(db);
  console.log('[quickstart] schema ready in Postgres (schema: agent_runtime)');

  const runtime = defineRuntime({
    db,
    provider: {
      baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: modelKey,
      model: process.env.MODEL_ID ?? 'gpt-4o-mini',
    },
    mcpServers: [
      {
        name: 'quickstart',
        url: mcp.url,
        tools: ['notes__search', 'billing__refund'],
      },
    ],
    tools: [notesSearch, billingRefund],
    loadSystemPrompt: async () => 'You are a helpful assistant.',
    loadHistory: async () => [],
    policies: { requireApproval: ['billing__refund'] },
    onPolicyDecision: (decision) => {
      console.log(
        `[policy] rule=${decision.rule} decision=${decision.decision}` +
          (decision.toolName ? ` tool=${decision.toolName}` : ''),
      );
    },
  });

  const worker = runWorker({
    runtime,
    db,
    retryDelayMs: 1_000,
    onSucceeded: async (invocation) => {
      console.log(`[worker] invocation ${invocation.id} succeeded`);
    },
    onFailed: async (invocation, error) => {
      console.log(
        `[worker] invocation ${invocation.id} failed (${error.message})`,
      );
    },
  });

  try {
    console.log('\n[app] story 1: look up the roadmap note');
    const search = await runtime.invoke({
      scope: 'demo',
      prompt: 'Find the roadmap note and tell me what it says.',
    });
    console.log(`[app] invocation ${search.invocationId}: ${search.text}`);

    console.log(
      '\n[app] story 2: a refund that policy gates on human approval',
    );
    let refundId: string | undefined;
    try {
      await runtime.invoke({
        scope: 'demo',
        prompt: 'Refund the charge for order 42.',
        maxAttempts: 1,
      });
      console.log('[app] UNEXPECTED: the refund invocation succeeded');
    } catch (error) {
      if (!(error instanceof AgentRuntimeError)) throw error;
      refundId = error.diagnostics.invocationId as string;
      console.log(
        `[app] invocation ${refundId} stopped as designed: ${error.message} ` +
          `(code: ${String(error.diagnostics.code)})`,
      );
    }

    const ids = [search.invocationId, refundId].filter(
      (id): id is string => id !== undefined,
    );
    const invocations = await db.pool.query(
      `select id, status, attempt_count, last_error_code
         from agent_runtime.invocations where id = any($1) order by id`,
      [ids],
    );
    const decisions = await db.pool.query(
      `select invocation_id, rule, decision, tool_name
         from agent_runtime.policy_decisions
        where invocation_id = any($1) order by id`,
      [ids],
    );
    console.log('\n[audit] what landed in Postgres:');
    for (const row of invocations.rows) {
      console.log(
        `  invocation ${row.id}: status=${row.status} attempts=${row.attempt_count}` +
          (row.last_error_code ? ` error=${row.last_error_code}` : ''),
      );
    }
    for (const row of decisions.rows) {
      console.log(
        `  policy_decision invocation=${row.invocation_id} rule=${row.rule} ` +
          `decision=${row.decision}${row.tool_name ? ` tool=${row.tool_name}` : ''}`,
      );
    }
    console.log(
      '\n[done] the search executed through MCP, the gated refund never ran, ' +
        'and every ruling is in the audit tables.',
    );
  } finally {
    await worker.stop();
  }
} finally {
  await db.close();
  await mcp.close();
}
