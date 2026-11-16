import { AgentRuntimeError } from '../contracts/errors.js';
import type {
  BudgetCompleteness,
  BudgetExceededLimit,
  BudgetLimitKind,
  BudgetWarningEvent,
  PolicyDecision,
  RuntimePolicies,
} from '../contracts/policy.js';
import type { InvocationUsage, PendingToolCall } from '../contracts/runtime.js';
import { canonicalJson } from './canonical-json.js';
import { usageStepsOverflow } from './usage.js';

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

interface ValidatedBudget {
  maxCostUsd?: number;
  maxTokens?: number;
  onExceeded: 'stop' | 'log';
}

interface PolicyEngineHooks {
  onDecision?: (decision: PolicyRuling) => void;
  onBudgetWarning?: (warning: BudgetWarningEvent) => void;
  correctionForInvalidCall?: (call: ParsedToolCall) => string | undefined;
  approvedToolCall?: PendingToolCall;
}

const BUDGET_TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

function validateBudget(
  budget: RuntimePolicies['budget'],
): ValidatedBudget | undefined {
  if (!budget) return undefined;
  const onExceeded = budget.onExceeded ?? 'stop';
  if (onExceeded !== 'stop' && onExceeded !== 'log') {
    throw new Error("budget.onExceeded must be 'stop' or 'log'");
  }
  if (budget.maxCostUsd === undefined && budget.maxTokens === undefined) {
    throw new Error('budget requires maxCostUsd or maxTokens');
  }
  if (
    budget.maxCostUsd !== undefined &&
    (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd <= 0)
  ) {
    throw new Error('budget.maxCostUsd must be a positive finite number');
  }
  if (
    budget.maxTokens !== undefined &&
    (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens <= 0)
  ) {
    throw new Error('budget.maxTokens must be a positive integer');
  }
  return {
    ...(budget.maxCostUsd !== undefined
      ? { maxCostUsd: budget.maxCostUsd }
      : {}),
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
    onExceeded,
  };
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
  private readonly budget?: ValidatedBudget;
  private readonly budgetWarned: Record<BudgetLimitKind, boolean> = {
    tokens: false,
    costUsd: false,
  };
  private readonly budgetExceeded: Record<BudgetLimitKind, boolean> = {
    tokens: false,
    costUsd: false,
  };
  private readonly budgetExceededDetails: Partial<
    Record<BudgetLimitKind, BudgetExceededLimit>
  > = {};
  private readonly budgetIncomplete: Record<BudgetLimitKind, boolean> = {
    tokens: false,
    costUsd: false,
  };
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
    this.budget = validateBudget(policies.budget);
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
    if (
      !this.terminal ||
      error.diagnostics.code === 'audit_persistence_failed'
    ) {
      this.terminal = error;
    }
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

    const requiresApproval = this.isApprovalRequired(
      input.scope,
      input.toolName,
      input.toolInput,
    );
    const matchesApproval =
      this.approvedToolCall !== undefined &&
      isSameToolCall(this.approvedToolCall, input.toolName, input.toolInput);
    if (requiresApproval && !matchesApproval) {
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

    // A grant waives approval, not the invocation's other policies.
    if (requiresApproval && matchesApproval) {
      this.approvedToolCall = undefined;
      this.record({
        rule: 'require_approval',
        decision: 'allow',
        toolName: input.toolName,
        detail: { viaApproval: true },
      });
    }
    // Reserve synchronously: the SDK approves parallel calls before executing them.
    this.approvedToolCalls += 1;
    return 'not-applicable';
  }

  afterStep(toolCalls: readonly ParsedToolCall[]): void {
    if (this.terminal) return;

    if (this.pendingCorrection) {
      if (toolCalls.length === 0) {
        if (this.pendingCorrection.correctionsUsed >= this.correctionBudget) {
          this.exhaustCorrection(toolCalls);
        } else {
          this.pendingCorrection.correctionsUsed += 1;
          this.record({
            rule:
              this.pendingCorrection.kind === 'multi-call'
                ? 'exactly_one'
                : 'input_validation',
            decision: 'correction_issued',
          });
        }
        return;
      }
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

  evaluateBudget(
    usage: InvocationUsage,
    stepNumber: number,
    canContinue: boolean,
  ): void {
    const budget = this.budget;
    if (!budget) return;

    const existingTerminal =
      this.terminal &&
      this.terminal.diagnostics.code !== 'audit_persistence_failed'
        ? this.terminal
        : undefined;
    const terminalOnThisStep =
      existingTerminal?.diagnostics.code ??
      (canContinue ? undefined : 'final_step');

    const tokenTotal = BUDGET_TOKEN_FIELDS.reduce(
      (total, key) => total + BigInt(usage[key]),
      0n,
    );
    const accumulatedTokens =
      tokenTotal > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(tokenTotal);
    const tokenCompleteness: BudgetCompleteness =
      usage.steps.every((step) => step.usageKnown) &&
      !usageStepsOverflow(usage.steps)
        ? 'complete'
        : 'lower_bound';

    const warn = (
      limitKind: BudgetLimitKind,
      accumulated: number,
      limit: number,
      completeness: BudgetCompleteness,
    ): void => {
      if (this.budgetWarned[limitKind]) return;
      this.budgetWarned[limitKind] = true;
      const event: BudgetWarningEvent = {
        limitKind,
        accumulated,
        limit,
        threshold: 0.8,
        stepNumber,
        completeness,
      };
      this.record({
        rule: 'budget',
        decision: 'warning',
        detail: { event: 'warning', ...event, onExceeded: budget.onExceeded },
      });
      try {
        this.hooks.onBudgetWarning?.(event);
      } catch {
        // Budget warnings are observational and must not affect execution.
      }
    };

    if (budget.maxTokens !== undefined) {
      const limit = BigInt(budget.maxTokens);
      if (tokenTotal * 5n >= limit * 4n) {
        warn('tokens', accumulatedTokens, budget.maxTokens, tokenCompleteness);
      }
      if (tokenTotal >= limit) {
        if (!this.budgetExceeded.tokens) {
          this.budgetExceeded.tokens = true;
          const detail: BudgetExceededLimit = {
            limitKind: 'tokens',
            accumulated: accumulatedTokens,
            limit: budget.maxTokens,
            stepNumber,
            completeness: tokenCompleteness,
          };
          this.budgetExceededDetails.tokens = detail;
          this.record({
            rule: 'budget',
            decision: 'exceeded',
            detail: {
              event: 'exceeded',
              ...detail,
              ...(terminalOnThisStep ? { terminal: terminalOnThisStep } : {}),
            },
          });
        }
      } else if (
        tokenCompleteness === 'lower_bound' &&
        !this.budgetIncomplete.tokens
      ) {
        this.budgetIncomplete.tokens = true;
        this.record({
          rule: 'budget',
          decision: 'incomplete',
          detail: {
            event: 'incomplete',
            limitKind: 'tokens',
            accumulated: accumulatedTokens,
            limit: budget.maxTokens,
            stepNumber,
            onExceeded: budget.onExceeded,
            completeness: tokenCompleteness,
            reason: 'usage_incomplete',
          },
        });
      }
    }

    if (budget.maxCostUsd !== undefined) {
      const cost = usage.costUsd;
      if (
        cost !== undefined &&
        Number.isFinite(cost) &&
        !usage.costIncomplete
      ) {
        if (cost >= budget.maxCostUsd * 0.8) {
          warn('costUsd', cost, budget.maxCostUsd, 'complete');
        }
        if (cost >= budget.maxCostUsd) {
          if (!this.budgetExceeded.costUsd) {
            this.budgetExceeded.costUsd = true;
            const detail: BudgetExceededLimit = {
              limitKind: 'costUsd',
              accumulated: cost,
              limit: budget.maxCostUsd,
              stepNumber,
              completeness: 'complete',
            };
            this.budgetExceededDetails.costUsd = detail;
            this.record({
              rule: 'budget',
              decision: 'exceeded',
              detail: {
                event: 'exceeded',
                ...detail,
                ...(terminalOnThisStep ? { terminal: terminalOnThisStep } : {}),
              },
            });
          }
        }
      } else if (!this.budgetIncomplete.costUsd) {
        this.budgetIncomplete.costUsd = true;
        this.record({
          rule: 'budget',
          decision: 'incomplete',
          detail: {
            event: 'incomplete',
            limitKind: 'costUsd',
            accumulated: null,
            knownCostUsd: cost ?? null,
            limit: budget.maxCostUsd,
            stepNumber,
            onExceeded: budget.onExceeded,
            completeness: 'lower_bound',
            reason: 'cost_unknown',
          },
        });
      }
    }

    const exceeded = Object.values(this.budgetExceededDetails).filter(
      (detail): detail is BudgetExceededLimit => detail !== undefined,
    );
    if (
      exceeded.length > 0 &&
      budget.onExceeded === 'stop' &&
      canContinue &&
      !existingTerminal
    ) {
      const auditFailure =
        this.terminal?.diagnostics.code === 'audit_persistence_failed'
          ? this.terminal.message
          : undefined;
      this.terminal = new AgentRuntimeError(
        'budget',
        'Invocation budget exceeded',
        {
          code: 'budget_exceeded',
          limits: exceeded,
          ...(auditFailure ? { auditFailure } : {}),
        },
        { usage },
      );
    }
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

  private isApprovalRequired(
    scope: string,
    toolName: string,
    input: unknown,
  ): boolean {
    const policy = this.policies.requireApproval;
    return typeof policy === 'function'
      ? policy({ scope, toolName, input })
      : (policy?.includes(toolName) ?? false);
  }

  private record(decision: PolicyRuling): void {
    try {
      this.hooks.onDecision?.(decision);
    } catch {
      // Policy reporting must not affect the invocation.
    }
  }
}
