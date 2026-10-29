import { AgentRuntimeError } from '../contracts/errors';
import type { PolicyDecision, RuntimePolicies } from '../contracts/policy';
import type { PendingToolCall } from '../contracts/runtime';

const TOOL_PROPOSAL_CORRECTION =
  'Return exactly one tool call for the next required step. Wait for its result before proposing another tool.';

export interface ParsedToolCall {
  toolName: string;
  input: unknown;
  invalid?: boolean;
}

interface PendingCorrection {
  kind: 'multi-call' | 'input-validation';
  instruction: string;
  toolName?: string;
  correctionsUsed: number;
}

type PolicyRuling = Omit<PolicyDecision, 'scope' | 'invocationId' | 'runId'>;

interface PolicyEngineHooks {
  onDecision?: (decision: PolicyRuling) => void;
  correctionForInvalidCall?: (call: ParsedToolCall) => string | undefined;
  approvedToolCall?: PendingToolCall;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isSameToolCall(
  approved: PendingToolCall,
  toolName: string,
  input: unknown,
): boolean {
  return (
    approved.toolName === toolName &&
    canonicalJson(approved.input) === canonicalJson(input)
  );
}

type ToolApprovalVerdict =
  | 'not-applicable'
  | { type: 'denied'; reason: string };

export class PolicyEngine {
  private readonly exactlyOne: boolean;
  private readonly correctionBudget: number;
  private readonly maxToolCallsPerInvocation: number;
  private pendingCorrection?: PendingCorrection;
  private terminal?: AgentRuntimeError;
  private approvedToolCalls = 0;
  private approvedToolCall?: PendingToolCall;
  private pendingApproval?: PendingToolCall;

  constructor(
    private readonly policies: RuntimePolicies,
    private readonly hooks: PolicyEngineHooks = {},
  ) {
    this.exactlyOne = policies.exactlyOneToolCallPerStep ?? true;
    this.correctionBudget = policies.correctionBudget ?? 1;
    this.maxToolCallsPerInvocation = policies.maxToolCallsPerInvocation ?? 8;
    this.approvedToolCall = hooks.approvedToolCall;
    for (const [name, value] of [
      ['correctionBudget', this.correctionBudget],
      ['maxToolCallsPerInvocation', this.maxToolCallsPerInvocation],
    ] as const) {
      if (
        !Number.isSafeInteger(value) ||
        value < (name === 'correctionBudget' ? 0 : 1)
      ) {
        throw new Error(
          `${name} must be a ${name === 'correctionBudget' ? 'non-negative' : 'positive'} integer`,
        );
      }
    }
  }

  get terminalError(): AgentRuntimeError | undefined {
    return this.terminal;
  }

  get pendingApprovalCall(): PendingToolCall | undefined {
    return this.pendingApproval;
  }

  fail(error: AgentRuntimeError): void {
    this.terminal ??= error;
  }

  correctionInstruction(): string | undefined {
    return this.pendingCorrection?.instruction;
  }

  approvalFor(input: {
    toolName: string;
    toolCallId: string;
    toolInput: unknown;
    proposalCount: number;
    scope: string;
  }): ToolApprovalVerdict {
    if (this.exactlyOne && input.proposalCount > 1) {
      this.record({
        rule: 'exactly_one',
        decision: 'deny',
        toolName: input.toolName,
      });
      return { type: 'denied', reason: TOOL_PROPOSAL_CORRECTION };
    }

    const allowlist =
      typeof this.policies.toolAllowlist === 'function'
        ? this.policies.toolAllowlist(input.scope)
        : this.policies.toolAllowlist;
    if (allowlist && !allowlist.includes(input.toolName)) {
      this.record({
        rule: 'allowlist',
        decision: 'deny',
        toolName: input.toolName,
      });
      return {
        type: 'denied',
        reason: `Tool ${input.toolName} is not available under the current policy.`,
      };
    }

    if (
      this.pendingCorrection?.kind === 'input-validation' &&
      input.toolName !== this.pendingCorrection.toolName
    ) {
      this.record({
        rule: 'input_validation',
        decision: 'deny',
        toolName: input.toolName,
      });
      this.terminal ??= new AgentRuntimeError(
        'failure',
        `Provider did not return a corrected ${this.pendingCorrection.toolName} tool call`,
      );
      return {
        type: 'denied',
        reason:
          'The correction must call the same tool with corrected arguments.',
      };
    }

    if (this.policies.requireApproval?.includes(input.toolName)) {
      if (
        this.approvedToolCall &&
        isSameToolCall(this.approvedToolCall, input.toolName, input.toolInput)
      ) {
        // A grant covers the exact approved call, and only once.
        this.approvedToolCall = undefined;
        this.approvedToolCalls += 1;
        this.record({
          rule: 'require_approval',
          decision: 'allow',
          toolName: input.toolName,
          detail: { viaApproval: true },
        });
        return 'not-applicable';
      }
      this.pendingApproval ??= {
        toolName: input.toolName,
        input: input.toolInput,
      };
      this.record({
        rule: 'require_approval',
        decision: 'approval_requested',
        toolName: input.toolName,
        detail: { toolCallId: input.toolCallId },
      });
      this.terminal ??= new AgentRuntimeError(
        'failure',
        `Tool ${input.toolName} requires approval before execution`,
        {
          code: 'approval_required',
          toolName: input.toolName,
          pendingToolCall: this.pendingApproval,
        },
      );
      return {
        type: 'denied',
        reason: 'This tool call requires approval before it can run.',
      };
    }

    if (this.approvedToolCalls >= this.maxToolCallsPerInvocation) {
      this.record({
        rule: 'max_tool_calls',
        decision: 'deny',
        toolName: input.toolName,
        detail: { maxToolCallsPerInvocation: this.maxToolCallsPerInvocation },
      });
      this.terminal = new AgentRuntimeError(
        'failure',
        'Tool-call budget exceeded',
      );
      return { type: 'denied', reason: 'Tool-call budget exhausted.' };
    }

    // Reserve synchronously: the SDK approves parallel calls before executing them.
    this.approvedToolCalls += 1;
    return 'not-applicable';
  }

  afterStep(toolCalls: readonly ParsedToolCall[]): void {
    if (this.terminal) return;

    if (this.pendingCorrection) {
      const only = toolCalls.length === 1 ? toolCalls[0] : undefined;
      if (only && !only.invalid) {
        this.pendingCorrection = undefined;
        return;
      }
      if (this.pendingCorrection.correctionsUsed < this.correctionBudget) {
        const chain = this.pendingCorrection.correctionsUsed;
        this.pendingCorrection = undefined;
        this.handleViolation(toolCalls, chain);
        return;
      }
      this.recordInvalidCalls(toolCalls);
      this.exhaustCorrection(toolCalls);
      return;
    }

    this.handleViolation(toolCalls, 0);
  }

  private handleViolation(
    toolCalls: readonly ParsedToolCall[],
    chainCorrections: number,
  ): void {
    this.recordInvalidCalls(toolCalls);
    if (this.exactlyOne && toolCalls.length > 1) {
      if (chainCorrections >= this.correctionBudget) {
        this.exhaustCorrection(toolCalls);
        return;
      }
      this.pendingCorrection = {
        kind: 'multi-call',
        instruction: TOOL_PROPOSAL_CORRECTION,
        correctionsUsed: chainCorrections + 1,
      };
      this.record({ rule: 'exactly_one', decision: 'correction_issued' });
      return;
    }

    const invalid = toolCalls.find((toolCall) => toolCall.invalid);
    if (!invalid) return;

    const correction = this.hooks.correctionForInvalidCall?.(invalid);
    if (correction) {
      if (chainCorrections >= this.correctionBudget) {
        this.exhaustCorrection(toolCalls);
        return;
      }
      this.pendingCorrection = {
        kind: 'input-validation',
        instruction: correction,
        toolName: invalid.toolName,
        correctionsUsed: chainCorrections + 1,
      };
      this.record({
        rule: 'input_validation',
        decision: 'correction_issued',
        toolName: invalid.toolName,
      });
      return;
    }

    this.terminal = new AgentRuntimeError(
      'failure',
      'Provider returned invalid tool input',
    );
  }

  private recordInvalidCalls(toolCalls: readonly ParsedToolCall[]): void {
    for (const call of toolCalls) {
      if (call.invalid) {
        this.record({
          rule: 'input_validation',
          decision: 'deny',
          toolName: call.toolName,
        });
      }
    }
  }

  private exhaustCorrection(toolCalls: readonly ParsedToolCall[]): void {
    this.record({
      rule: 'correction_budget',
      decision: 'deny',
      detail: { correctionBudget: this.correctionBudget },
    });
    this.terminal = new AgentRuntimeError(
      'failure',
      toolCalls.length === 0
        ? 'Provider did not return a corrected tool call'
        : toolCalls.length > 1
          ? 'Provider returned multiple tool calls'
          : 'Provider returned invalid tool input',
      toolCalls.length > 1 ? { code: 'multiple_tool_calls' } : undefined,
    );
  }

  private record(decision: PolicyRuling): void {
    try {
      this.hooks.onDecision?.(decision);
    } catch {
      // Policy reporting must not affect the invocation.
    }
  }
}
