import {
  tool,
  ToolLoopAgent,
  type LanguageModel,
  type ModelMessage,
  type StepResultPerformance,
  type ToolSet,
} from 'ai';
import { z } from 'zod';

import { AgentRuntimeError } from '../contracts/errors';
import type {
  PolicyDecision,
  RuntimePolicies,
  ToolDefinition,
} from '../contracts/policy';
import type {
  AgentRuntime,
  HistoryLoader,
  InvocationResult,
  McpToolClient,
  McpToolSession,
  RuntimeInvocationInput,
  RuntimeMetrics,
  SystemPromptLoader,
} from '../contracts/runtime';
import { PolicyEngine, type ParsedToolCall } from './policy-engine';

/**
 * The prompt layer of the exactly-one policy — the weakest of its three
 * layers (prompt contract, provider `parallel_tool_calls: false`, and
 * execution-path denial). Appended to the system prompt only while
 * `exactlyOneToolCallPerStep` is enabled.
 */
export const TOOL_EXECUTION_CONTRACT = [
  'Tool execution contract:',
  '- Propose exactly one tool call in each assistant response when tools are needed.',
  '- Wait for that tool result before deciding on the next tool call.',
  '- Omit optional arguments when the user or context did not provide a meaningful value.',
  '- Never use empty strings as placeholders for omitted optional arguments.',
].join('\n');

export interface AiSdkNativeRuntimeOptions {
  model: LanguageModel;
  /** Registered tools. Executed through `mcpClient` (ADR-007). */
  tools?: ToolDefinition[];
  mcpClient?: McpToolClient;
  loadSystemPrompt?: SystemPromptLoader;
  loadHistory?: HistoryLoader;
  policies?: RuntimePolicies;
  now?: () => number;
  onMetrics?: (metrics: RuntimeMetrics) => void;
  onPolicyDecision?: (decision: PolicyDecision) => void;
}

interface InvocationState {
  currentProposalCount: number;
  toolCallCount: number;
  session?: McpToolSession;
}

interface StepTimings {
  providerCallCount: number;
  totalProviderMs: number;
  totalToolMs: number;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function aggregateStepTimings(
  steps: ReadonlyArray<{
    performance: Pick<
      StepResultPerformance,
      'responseTimeMs' | 'toolExecutionMs'
    >;
  }>,
): StepTimings {
  return {
    providerCallCount: steps.length,
    totalProviderMs: sum(steps.map((step) => step.performance.responseTimeMs)),
    totalToolMs: sum(
      steps.flatMap((step) => Object.values(step.performance.toolExecutionMs)),
    ),
  };
}

function normalizeProviderName(provider: string): string {
  return provider.endsWith('.chat')
    ? provider.slice(0, -'.chat'.length)
    : provider;
}

function findAgentRuntimeError(error: unknown): AgentRuntimeError | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (current instanceof AgentRuntimeError) return current;
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
}

function isTimeoutFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (
      current instanceof Error &&
      ['AbortError', 'TimeoutError'].includes(current.name)
    ) {
      return true;
    }
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

/** Unwrap ZodEffects / ZodOptional layers down to a ZodObject shape, if any. */
function zodObjectShape(
  schema: z.ZodType,
): Record<string, z.ZodType> | undefined {
  let current: unknown = schema;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (current instanceof z.ZodObject) {
      return current.shape as Record<string, z.ZodType>;
    }
    const def = (current as { _def?: Record<string, unknown> })._def;
    current = def?.['schema'] ?? def?.['innerType'];
  }
  return undefined;
}

function dropBlankOptionalStringArguments(
  rawArguments: unknown,
  inputShape: Record<string, z.ZodType>,
): unknown {
  if (
    typeof rawArguments !== 'object' ||
    rawArguments === null ||
    Array.isArray(rawArguments)
  ) {
    return rawArguments;
  }
  const normalized: Record<string, unknown> = { ...rawArguments };
  for (const [key, fieldSchema] of Object.entries(inputShape)) {
    const value = normalized[key];
    if (
      typeof value === 'string' &&
      value.trim() === '' &&
      fieldSchema.safeParse(undefined).success &&
      !fieldSchema.safeParse(value).success
    ) {
      delete normalized[key];
    }
  }
  return normalized;
}

function modelMessages(
  history: readonly { role: 'user' | 'assistant' | 'system'; content: string }[],
  input: RuntimeInvocationInput,
): ModelMessage[] {
  return [
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: 'user', content: input.prompt },
  ];
}

/**
 * The execution engine: one invocation's tool loop on the Vercel AI SDK
 * (ADR-008), with the tool-call policy enforced on the execution path by
 * `PolicyEngine` (ADR-004). Tools are definitions; every execution is a
 * call through the configured MCP client, inside one session per
 * invocation attempt.
 */
export class AiSdkNativeRuntime implements AgentRuntime {
  private readonly now: () => number;
  private readonly maxDurationMs: number;
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition>;

  constructor(private readonly options: AiSdkNativeRuntimeOptions) {
    this.now = options.now ?? performance.now.bind(performance);
    this.maxDurationMs = options.policies?.maxDurationMs ?? 120_000;
    if (!Number.isSafeInteger(this.maxDurationMs) || this.maxDurationMs <= 0) {
      throw new Error('maxDurationMs must be a positive integer');
    }
    this.toolsByName = new Map(
      (options.tools ?? []).map((definition) => [definition.name, definition]),
    );
    if (this.toolsByName.size > 0 && !options.mcpClient) {
      throw new Error(
        'mcpClient is required when tools are registered (tools execute through MCP)',
      );
    }
  }

  async invoke(input: RuntimeInvocationInput): Promise<InvocationResult> {
    const startedAt = this.now();
    const state: InvocationState = { currentProposalCount: 0, toolCallCount: 0 };
    const policy = new PolicyEngine(this.options.policies ?? {}, {
      onDecision: this.options.onPolicyDecision,
      correctionForInvalidCall: (call) => this.correctionFor(call),
    });

    try {
      const systemPrompt = this.options.loadSystemPrompt
        ? await this.options.loadSystemPrompt(input)
        : '';
      const contextLoadedAt = this.now();
      const history = this.options.loadHistory
        ? await this.options.loadHistory(input)
        : [];
      const historyLoadedAt = this.now();

      const exactlyOne =
        this.options.policies?.exactlyOneToolCallPerStep ?? true;
      const baseInstructions = [
        systemPrompt,
        exactlyOne ? TOOL_EXECUTION_CONTRACT : '',
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');

      const tools = this.createTools(input, startedAt, state, policy);
      const agent = new ToolLoopAgent({
        model: this.options.model,
        tools,
        instructions: baseInstructions,
        repairToolCall: async ({ toolCall }) =>
          this.repairBlankOptionalStrings(toolCall),
        prepareStep: () => {
          this.remaining(startedAt);
          const correction = policy.correctionInstruction();
          return {
            instructions: correction
              ? `${baseInstructions}\n\n${correction}`
              : baseInstructions,
          };
        },
        onLanguageModelCallEnd: (event) => {
          state.currentProposalCount = event.content.filter(
            (part) => part.type === 'tool-call',
          ).length;
        },
        toolApproval: ({ toolCall }) =>
          policy.approvalFor({
            toolName: toolCall.toolName,
            proposalCount: state.currentProposalCount,
            executedToolCalls: state.toolCallCount,
            scope: input.scope,
          }),
        onStepEnd: (step) => {
          policy.afterStep(step.toolCalls as ParsedToolCall[]);
        },
        stopWhen: () => policy.terminalError != null,
      });

      const result = await agent.generate({
        messages: modelMessages(history, input),
        timeout: this.remaining(startedAt),
      });

      if (policy.terminalError) throw policy.terminalError;
      const text = result.text.trim();
      const provider = normalizeProviderName(result.finalStep.model.provider);
      const model = result.finalStep.model.modelId;
      if (!text) {
        throw new AgentRuntimeError(
          'failure',
          'Provider response contained no assistant text',
          { provider, model },
        );
      }

      const completedAt = this.now();
      this.emitMetrics({
        runId: input.runId,
        contextLoadMs: contextLoadedAt - startedAt,
        historyLoadMs: historyLoadedAt - contextLoadedAt,
        toolCallCount: state.toolCallCount,
        ...aggregateStepTimings(result.steps),
        totalMs: completedAt - startedAt,
      });

      return { invocationId: input.invocationId, runId: input.runId, text, provider, model };
    } catch (error) {
      const runtimeError = findAgentRuntimeError(error);
      if (runtimeError) throw runtimeError;
      if (isTimeoutFailure(error)) {
        throw new AgentRuntimeError('timeout', 'Native runtime timed out');
      }
      throw new AgentRuntimeError('failure', 'Native runtime failed');
    } finally {
      await state.session?.close().catch(() => undefined);
    }
  }

  private createTools(
    input: RuntimeInvocationInput,
    startedAt: number,
    state: InvocationState,
    policy: PolicyEngine,
  ): ToolSet {
    return Object.fromEntries(
      [...this.toolsByName.values()].map((definition) => {
        const name = definition.name;
        return [
          name,
          tool({
            description: definition.description,
            inputSchema: definition.inputSchema,
            execute: async (arguments_) => {
              try {
                state.session ??= await this.options.mcpClient!.open({
                  runId: input.runId,
                  timeoutMs: this.remaining(startedAt),
                });
                state.toolCallCount += 1;
                return await state.session.callTool({
                  name,
                  arguments: arguments_ as Record<string, unknown>,
                  timeoutMs: this.remaining(startedAt),
                });
              } catch (error) {
                // A hard MCP failure is terminal: the model must not be
                // given another turn to improvise around it.
                policy.fail(
                  findAgentRuntimeError(error) ??
                    new AgentRuntimeError('failure', 'MCP tool call failed'),
                );
                throw error;
              }
            },
          }),
        ];
      }),
    ) as ToolSet;
  }

  /**
   * Ask the tool's `validateInput` hook whether a schema-invalid proposal
   * is correctable. Blank optional strings are normalized away first, so
   * validators see the same input the repaired call would carry.
   */
  private correctionFor(call: ParsedToolCall): string | undefined {
    const definition = this.toolsByName.get(call.toolName);
    if (!definition?.validateInput) return undefined;
    const shape = zodObjectShape(definition.inputSchema);
    const normalized = shape
      ? dropBlankOptionalStringArguments(call.input, shape)
      : call.input;
    const verdict = definition.validateInput(normalized);
    return verdict.ok ? undefined : verdict.correction;
  }

  private repairBlankOptionalStrings(toolCall: {
    toolCallId: string;
    toolName: string;
    input: string;
  }) {
    const definition = this.toolsByName.get(toolCall.toolName);
    if (!definition) return null;
    const shape = zodObjectShape(definition.inputSchema);
    if (!shape) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.input) as unknown;
    } catch {
      return null;
    }

    const normalized = dropBlankOptionalStringArguments(parsed, shape);
    if (JSON.stringify(normalized) === JSON.stringify(parsed)) {
      return null;
    }

    return {
      type: 'tool-call' as const,
      toolCallType: 'function' as const,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: JSON.stringify(normalized),
    };
  }

  private remaining(startedAt: number): number {
    const remaining = this.maxDurationMs - (this.now() - startedAt);
    if (remaining <= 0) {
      throw new AgentRuntimeError('timeout', 'Native runtime timed out');
    }
    return Math.max(1, Math.floor(remaining));
  }

  private emitMetrics(metrics: RuntimeMetrics): void {
    try {
      this.options.onMetrics?.(metrics);
    } catch {
      // Metrics must not affect the user invocation.
    }
  }
}
