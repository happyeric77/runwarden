import { MockLanguageModelV4 } from 'ai/test';
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

// Scripted model: no API key, the same three proposals every run.
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

    if (promptText.includes('order 42')) {
      console.log('[model] proposing billing__refund (an approval-gated tool)');
      return finish([
        {
          type: 'tool-call',
          toolCallId: 'refund-1',
          toolName: 'billing__refund',
          input: JSON.stringify({
            amountCents: 5000,
            reason: 'Duplicate charge',
          }),
        },
      ]);
    }
    if (promptText.includes('Ship the runtime first')) {
      return finish([
        {
          type: 'text',
          text: 'The roadmap note says: ship the runtime first, add features later.',
        },
      ]);
    }
    if (promptText.includes('execution-denied')) {
      console.log(
        '[model] denial received; retrying with exactly one tool call',
      );
      return finish([
        {
          type: 'tool-call',
          toolCallId: 'search-2',
          toolName: 'notes__search',
          input: JSON.stringify({ query: 'roadmap' }),
        },
      ]);
    }
    console.log(
      '[model] proposing TWO tool calls in one step (policy violation)',
    );
    return finish([
      {
        type: 'tool-call',
        toolCallId: 'search-1a',
        toolName: 'notes__search',
        input: JSON.stringify({ query: 'roadmap' }),
      },
      {
        type: 'tool-call',
        toolCallId: 'search-1b',
        toolName: 'notes__search',
        input: JSON.stringify({ query: 'handbook' }),
      },
    ]);
  },
});

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
    model,
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
    console.log(
      '\n[app] story 1: a search whose first step breaks the exactly-one rule',
    );
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
      '\n[done] the violating step executed zero tools, the gated refund never ran, ' +
        'and every ruling is in the audit tables.',
    );
  } finally {
    await worker.stop();
  }
} finally {
  await db.close();
  await mcp.close();
}
