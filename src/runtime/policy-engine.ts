import { AgentRuntimeError } from '../contracts/errors';
import type {
  PolicyDecision,
  RuntimePolicies,
} from '../contracts/policy';

/** The instruction fed back to the model after a multi-call step is denied. */
export const TOOL_PROPOSAL_CORRECTION =
  'Return exactly one tool call for the next required step. Wait for its result before proposing another tool.';

export interface ParsedToolCall {
  toolName: string;
  input: unknown;
  invalid?: boolean;
}

interface PendingCorrection {
  kind: 'multi-call' | 'input-validation';
  instruction: string;
  /** For `input-validation`, the tool the correction must call again. */
  toolName?: string;
  correctionsUsed: number;
}

export interface PolicyEngineHooks {
  /** Called synchronously for every recorded policy ruling. */
  onDecision?: (decision: PolicyDecision) => void;
  /**
   * Given a schema-invalid proposed call, return a correction instruction
   * if the mistake is correctable (the tool's `validateInput` hook),
   * or `undefined` to fail the invocation.
   */
  correctionForInvalidCall?: (call: ParsedToolCall) => string | undefined;
}

export type ToolApprovalVerdict =
  | 'not-applicable'
  | { type: 'denied'; reason: string };

/**
 * The tool-call policy state machine (ADR-004). The runtime asks it to
 * approve every proposed call before execution, and reports every finished
 * step back to it. It owns:
 *
 * - the exactly-one rule (multi-call steps are denied wholesale),
 * - the allowlist and require-approval lists,
 * - the tool-call budget,
 * - the correction budget: a violating step earns a bounded number of
 *   correction turns per incident; a failed correction past the budget
 *   terminates the invocation with a specific error.
 */
export class PolicyEngine {
  private readonly exactlyOne: boolean;
  private readonly correctionBudget: number;
  private readonly maxToolCallsPerInvocation: number;
  private pendingCorrection?: PendingCorrection;
  private terminal?: AgentRuntimeError;

  constructor(
    private readonly policies: RuntimePolicies,
    private readonly hooks: PolicyEngineHooks = {},
  ) {
    this.exactlyOne = policies.exactlyOneToolCallPerStep ?? true;
    this.correctionBudget = policies.correctionBudget ?? 1;
    this.maxToolCallsPerInvocation =
      policies.maxToolCallsPerInvocation ?? 8;
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

  /**
   * Mark the invocation terminally failed from outside the proposal path —
   * e.g. a hard tool-execution (MCP) error, after which the model must not
   * be given another turn. The first failure wins.
   */
  fail(error: AgentRuntimeError): void {
    this.terminal ??= error;
  }

  /** The pending correction instruction to inject into the next step, if any. */
  correctionInstruction(): string | undefined {
    return this.pendingCorrection?.instruction;
  }

  approvalFor(input: {
    toolName: string;
    proposalCount: number;
    executedToolCalls: number;
    scope: string;
  }): ToolApprovalVerdict {
    if (this.exactlyOne && input.proposalCount > 1) {
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
      this.terminal ??= new AgentRuntimeError(
        'failure',
        `Provider did not return a corrected ${this.pendingCorrection.toolName} tool call`,
      );
      return {
        type: 'denied',
        reason: 'The correction must call the same tool with corrected arguments.',
      };
    }

    if (this.policies.requireApproval?.includes(input.toolName)) {
      this.record({
        rule: 'require_approval',
        decision: 'approval_requested',
        toolName: input.toolName,
      });
      // Phase 1 interception point: the durable awaiting_approval state
      // machine (ADR-011) replaces this failure with a resumable pause.
      this.terminal ??= new AgentRuntimeError(
        'failure',
        `Tool ${input.toolName} requires approval before execution`,
        { code: 'approval_required', toolName: input.toolName },
      );
      return {
        type: 'denied',
        reason: 'This tool call requires approval before it can run.',
      };
    }

    if (input.executedToolCalls >= this.maxToolCallsPerInvocation) {
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
      this.terminal = new AgentRuntimeError(
        'failure',
        toolCalls.length === 0
          ? 'Provider did not return a corrected tool call'
          : toolCalls.length > 1
            ? 'Provider returned multiple tool calls'
            : 'Provider returned invalid tool input',
        toolCalls.length > 1 ? { code: 'multiple_tool_calls' } : undefined,
      );
      return;
    }

    this.handleViolation(toolCalls, 0);
  }

  private handleViolation(
    toolCalls: readonly ParsedToolCall[],
    chainCorrections: number,
  ): void {
    if (this.exactlyOne && toolCalls.length > 1) {
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

  private record(decision: PolicyDecision): void {
    try {
      this.hooks.onDecision?.(decision);
    } catch {
      // Policy reporting must not affect the invocation.
    }
  }
}
