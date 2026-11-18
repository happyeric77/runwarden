/**
 * Budget-park approval demo.
 *
 * Runs the durable path end to end with a deterministic mock model:
 *   invocation -> budget crossing -> awaiting_approval -> grant -> resume.
 *
 * Prerequisites and commands are in ./README.md.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import {
  AgentRuntimeError,
  createDb,
  defineRuntime,
  initDb,
  runWorker,
  type BudgetRequest,
  type InvocationRecord,
  type McpToolClient,
  type ToolDefinition,
} from '../../src/index';

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://postgres:password@localhost:54332/runwarden_budget_demo';
const scope = 'budget-park-demo';
const maxTokens = 10;
const grantTokens = 15;
const pauseMs = Number.parseInt(process.env.DEMO_PAUSE_MS ?? '1200', 10);
const auto = process.argv.includes('--auto') || process.env.DEMO_AUTO === '1';
let effectiveMaxTokens = maxTokens;
let runTokens = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pause = async () => {
  if (Number.isFinite(pauseMs) && pauseMs > 0) await sleep(pauseMs);
};

function stepUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

function logStep(stepNumber: number, input: number, output: number) {
  runTokens = (stepNumber === 1 ? 0 : runTokens) + input + output;
  const over =
    runTokens > effectiveMaxTokens
      ? `, over by ${runTokens - effectiveMaxTokens}`
      : '';
  console.log(
    `[run] step ${stepNumber}: +${input} input, +${output} output; ` +
      `cumulative ${runTokens}/${effectiveMaxTokens} tokens${over}`,
  );
}

const summarizeLedger: ToolDefinition = {
  name: 'ledger__summarize',
  description: 'Summarize the ledger for a specific month.',
  inputSchema: z.object({ month: z.string() }),
};

const model = new MockLanguageModelV4({
  provider: 'demo-provider',
  modelId: 'demo-model',
  doGenerate: async ({ prompt }) => {
    const hasToolResult = prompt.some((message) => message.role === 'tool');
    if (!hasToolResult) {
      logStep(1, 6, 5);
      return {
        content: [
          {
            type: 'tool-call' as const,
            toolCallType: 'function' as const,
            toolCallId: 'call-ledger-1',
            toolName: 'ledger__summarize',
            input: JSON.stringify({ month: '2026-11' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
        usage: stepUsage(6, 5),
        warnings: [],
      };
    }

    logStep(2, 6, 6);
    return {
      content: [
        {
          type: 'text' as const,
          text: 'November ledger: 3 refunds, net -$42.00. No anomalies found.',
        },
      ],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: stepUsage(6, 6),
      warnings: [],
    };
  },
});

// A fake MCP session keeps the demo hermetic: no endpoint and no API key.
const mcpClient: McpToolClient = {
  open: async () => ({
    callTool: async ({ name }) => {
      console.log(`[run] tool ${name} executed via fake MCP`);
      return '[{"type":"text","text":"ledger summary ready"}]';
    },
    close: async () => {},
  }),
};

async function waitForParked(
  runtime: ReturnType<typeof defineRuntime>,
  id: string,
): Promise<InvocationRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = await runtime.listPendingApprovals(scope);
    const found = pending.find((record) => record.id === id);
    if (found) return found;
    await sleep(100);
  }
  throw new Error(`Invocation ${id} did not park for approval`);
}

async function waitForEnter() {
  process.stdout.write(
    `[approved] Press Enter to approve request with grant maxTokens=${grantTokens}... `,
  );
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

async function main() {
  const db = createDb(connectionString);
  try {
    await initDb(db);
    console.log('[setup] Postgres schema ready');

    const runtime = defineRuntime({
      db,
      model,
      tools: [summarizeLedger],
      mcpClient,
      loadSystemPrompt: async () =>
        'You are a budgeted ledger assistant. Use the ledger tool once, then answer.',
      loadHistory: async () => [],
      policies: {
        budget: { maxTokens, onExceeded: 'approve' },
      },
      onPolicyDecision: (decision) => {
        if (decision.rule !== 'budget' || decision.decision === 'warning')
          return;
        const detail = decision.detail as
          | {
              event?: string;
              limitKind?: string;
              accumulated?: number | null;
              limit?: number;
            }
          | undefined;
        const parts = [
          detail?.limitKind,
          detail?.accumulated === null || detail?.accumulated === undefined
            ? undefined
            : `accumulated=${detail.accumulated}`,
          detail?.limit === undefined ? undefined : `limit=${detail.limit}`,
        ].filter(Boolean);
        console.log(
          `[budget] ${decision.decision}${parts.length ? ` ${parts.join(' ')}` : ''}`,
        );
      },
      onBudgetWarning: (warning) => {
        console.log(
          `[budget] 80% warning ${warning.limitKind} ` +
            `accumulated=${warning.accumulated} limit=${warning.limit}`,
        );
      },
      onMetrics: (metrics) => {
        console.log(
          `[done] metrics providerCalls=${metrics.providerCallCount} ` +
            `toolCalls=${metrics.toolCallCount} totalMs=${Math.round(metrics.totalMs)}`,
        );
      },
    });

    const worker = runWorker({
      runtime,
      db,
      retryDelayMs: 250,
      pollIdleMs: 50,
      onSucceeded: async (invocation) => {
        console.log(
          `[done] worker marked invocation ${invocation.id} succeeded`,
        );
      },
      onFailed: async (invocation, error) => {
        console.error(
          `[failed] worker marked invocation ${invocation.id} failed: ${error.message}`,
        );
      },
      onAwaitingApproval: async (invocation, request) => {
        if (request.kind === 'budget') {
          console.log(
            `[parked] worker parked invocation ${invocation.id} ` +
              `for request ${request.budgetRequest.requestId}`,
          );
        }
      },
    });

    try {
      console.log(
        `\n[run] invoking with maxTokens=${maxTokens}; the first tool step crosses it`,
      );

      let invocationId: string;
      try {
        const completed = await runtime.invoke(
          {
            scope,
            prompt: 'Summarize the November ledger.',
            maxAttempts: 1,
          },
          { waitTimeoutMs: 30_000, pollIntervalMs: 100 },
        );
        console.log(
          `[done] invocation ${completed.invocationId}: ${completed.text}`,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof AgentRuntimeError) ||
          error.diagnostics.code !== 'approval_required'
        ) {
          throw error;
        }
        invocationId = String(error.diagnostics.invocationId);
      }

      const parked = await waitForParked(runtime, invocationId);
      const request = parked.pendingBudgetRequest as BudgetRequest;
      console.log(
        `\n[parked] invocation ${invocationId} status=${parked.status} ` +
          `requestId=${request.requestId}`,
      );
      for (const limit of request.limits) {
        console.log(
          `[parked] ${limit.limitKind}: accumulated=${limit.accumulated} ` +
            `limit=${limit.limit} step=${limit.stepNumber}`,
        );
      }
      console.log(
        `[parked] usage snapshot: input=${request.usage.inputTokens} ` +
          `output=${request.usage.outputTokens} ` +
          `total=${request.usage.inputTokens + request.usage.outputTokens}`,
      );

      if (auto) {
        console.log(
          `[approved] --auto: approving in ${Math.max(pauseMs, 0)}ms with ` +
            `grant maxTokens=${grantTokens}`,
        );
        await pause();
      } else {
        await waitForEnter();
      }

      effectiveMaxTokens = maxTokens + grantTokens;
      await runtime.approveInvocation(invocationId, {
        requestId: request.requestId,
        grant: { maxTokens: grantTokens },
        resolvedBy: 'demo-operator',
        note: 'Recording demo grant',
      });
      console.log(
        `[approved] granted +${grantTokens} tokens; effective limit is now ` +
          `${effectiveMaxTokens}. The worker resumes as a fresh run.`,
      );

      const completed = await runtime.waitForInvocation(invocationId, {
        waitTimeoutMs: 30_000,
        pollIntervalMs: 100,
      });
      const total =
        completed.usage.inputTokens +
        completed.usage.outputTokens +
        completed.usage.cacheReadTokens +
        completed.usage.cacheWriteTokens +
        completed.usage.reasoningTokens;
      console.log(
        `\n[done] invocation ${completed.invocationId}: ${completed.text}`,
      );
      console.log(
        `[done] total usage: input=${completed.usage.inputTokens} ` +
          `output=${completed.usage.outputTokens} total=${total} ` +
          `cost=${completed.usage.costUsd ?? 'unknown'} ` +
          `costIncomplete=${completed.usage.costIncomplete}`,
      );
    } finally {
      await worker.stop();
    }
  } finally {
    await db.close();
  }
}

await main();
