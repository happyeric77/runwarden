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
    '[quickstart] Set MODEL_API_KEY first. Any OpenAI-compatible endpoint ' +
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
    onAwaitingApproval: async (invocation, pendingToolCall) => {
      console.log(
        `[worker] invocation ${invocation.id} awaiting approval for ${pendingToolCall.toolName}`,
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
    let refundId: string;
    try {
      const refund = await runtime.invoke({
        scope: 'demo',
        prompt:
          'Refund the charge for order 42 using the refund tool: amount 5000 cents, reason: duplicate charge.',
        maxAttempts: 1,
      });
      refundId = refund.invocationId;
      console.log(`[app] invocation ${refundId}: ${refund.text}`);
    } catch (error) {
      if (
        !(error instanceof AgentRuntimeError) ||
        typeof error.diagnostics.invocationId !== 'string'
      ) {
        throw error;
      }
      refundId = error.diagnostics.invocationId;
      if (error.diagnostics.code !== 'approval_required') {
        console.log(
          `[app] invocation ${refundId} failed: ${error.message} ` +
            `(code: ${String(error.diagnostics.code)})`,
        );
      } else {
        console.log(
          `[app] invocation ${refundId} is parked in awaiting_approval: ` +
            'the refund was proposed and recorded, but not executed.',
        );
        const pending = await runtime.listPendingApprovals('demo');
        const parked = pending.find((record) => record.id === refundId);
        console.log(
          `[app] pending approval: ${parked?.pendingToolCall?.toolName} ` +
            `${JSON.stringify(parked?.pendingToolCall?.input)}`,
        );
        await runtime.approveInvocation(refundId, {
          resolvedBy: 'quickstart',
        });
        console.log(
          `[app] approved invocation ${refundId}; the worker reruns it ` +
            'from the start, and only the approved call may pass.',
        );
        const completed = await runtime.waitForInvocation(refundId, {
          pollIntervalMs: 250,
        });
        console.log(`[app] invocation ${refundId}: ${completed.text}`);
      }
    }

    const ids = [search.invocationId, refundId];
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
    const refundDecisions = decisions.rows.filter(
      (row) => String(row.invocation_id) === refundId,
    );
    if (
      refundDecisions.some(
        (row) =>
          row.rule === 'require_approval' &&
          row.decision === 'approval_requested' &&
          row.tool_name === 'billing__refund',
      ) &&
      refundDecisions.some((row) => row.decision === 'approved') &&
      invocations.rows.some(
        (row) => String(row.id) === refundId && row.status === 'succeeded',
      )
    ) {
      console.log(
        '\n[done] the gated refund ran only after approval: Postgres recorded approval_requested, the approval, and the rerun that executed the exact approved call.',
      );
    } else if (
      invocations.rows.some(
        (row) => String(row.id) === refundId && row.status === 'succeeded',
      ) &&
      refundDecisions.length === 0
    ) {
      console.log(
        '\n[done] the refund invocation succeeded with a model response; no gated call was proposed, so nothing was intercepted. The audit tables reflect this run.',
      );
    } else {
      console.log(
        '\n[done] no refund approval request was recorded. See the invocation outcome and policy decisions above.',
      );
    }
  } finally {
    await worker.stop();
  }
} finally {
  await db.close();
  await mcp.close();
}
