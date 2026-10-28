/**
 * Phase 1 demo: one governed invocation, end to end, with no external
 * services. Run with `pnpm demo`.
 *
 * A scripted mock model first proposes TWO tool calls in one step —
 * a violation of the default exactly-one policy — and the runtime denies
 * both before anything executes. The model then corrects itself with a
 * single call, which executes through a fake MCP client, and the
 * invocation completes with a final text answer.
 *
 * The policy decisions printed at the end are the same records a host
 * application would persist for audit via `onPolicyDecision`.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import {
  defineRuntime,
  type McpToolClient,
  type PolicyDecision,
  type ToolDefinition,
} from '../src/index';

const lookupNoteTool: ToolDefinition = {
  name: 'notes__lookup_note',
  description: 'Look up a note by its title keyword.',
  inputSchema: z.object({ query: z.string().min(1) }),
};

const fakeMcpClient: McpToolClient = {
  async open() {
    return {
      async callTool({ name, arguments: args }) {
        console.log(
          `[mcp] executed ${name} with ${JSON.stringify(args)} (fake server)`,
        );
        return JSON.stringify([
          {
            type: 'text',
            text: `Note found: "Roadmap" — ship the runtime first.`,
          },
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
      return finish([
        {
          type: 'text',
          text: 'The roadmap note says: ship the runtime first.',
        },
      ]);
    }
    if (promptText.includes('execution-denied')) {
      console.log(
        '[model] policy denial received; retrying with exactly one tool call',
      );
      return finish([
        {
          type: 'tool-call',
          toolCallId: 'call-2',
          toolName: 'notes__lookup_note',
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

const decisions: PolicyDecision[] = [];

const runtime = defineRuntime({
  model,
  mcpClient: fakeMcpClient,
  tools: [lookupNoteTool],
  loadSystemPrompt: async () => 'You are a helpful notes assistant.',
  loadHistory: async () => [],
  // Default policies: exactlyOneToolCallPerStep: true, correctionBudget: 1,
  // maxToolCallsPerInvocation: 8, maxDurationMs: 120_000.
  onPolicyDecision: (decision) => decisions.push(decision),
});

const result = await runtime.invoke({
  scope: 'demo-user',
  prompt: 'What does my roadmap note say?',
});

console.log(`[result] ${result.text}`);
console.log('[policy] decisions recorded during this invocation:');
for (const decision of decisions) {
  console.log(
    `  - rule=${decision.rule} decision=${decision.decision}` +
      (decision.toolName ? ` tool=${decision.toolName}` : ''),
  );
}
console.log(
  '[done] governed invocation completed: the violating step executed zero tools, the corrected single call executed once.',
);
