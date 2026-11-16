import type { z } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  validateInput?: (
    input: unknown,
  ) => { ok: true } | { ok: false; correction: string };
}

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  tools?: string[];
}

export type PolicyRule =
  | 'exactly_one'
  | 'max_tool_calls'
  | 'allowlist'
  | 'require_approval'
  | 'input_validation'
  | 'correction_budget'
  | 'budget';

export type PolicyDecisionKind =
  | 'allow'
  | 'deny'
  | 'correction_issued'
  | 'approval_requested'
  | 'approved'
  | 'rejected'
  | 'warning'
  | 'exceeded'
  | 'incomplete';

export interface PolicyDecision {
  scope: string;
  invocationId: string;
  runId: string;
  rule: PolicyRule;
  decision: PolicyDecisionKind;
  toolName?: string;
  detail?: Record<string, unknown>;
}

export type BudgetLimitKind = 'costUsd' | 'tokens';
export type BudgetCompleteness = 'complete' | 'lower_bound';

export interface RuntimeBudgetPolicy {
  maxCostUsd?: number;
  maxTokens?: number;
  onExceeded?: 'stop' | 'log';
}

export interface BudgetWarning {
  scope: string;
  invocationId: string;
  runId: string;
  limitKind: BudgetLimitKind;
  accumulated: number;
  limit: number;
  threshold: 0.8;
  stepNumber: number;
  completeness: BudgetCompleteness;
}

export type BudgetWarningEvent = Omit<
  BudgetWarning,
  'scope' | 'invocationId' | 'runId'
>;

export interface BudgetExceededLimit {
  limitKind: BudgetLimitKind;
  accumulated: number;
  limit: number;
  stepNumber: number;
  completeness: BudgetCompleteness;
}

export interface RuntimePolicies {
  exactlyOneToolCallPerStep?: boolean;
  correctionBudget?: number;
  maxToolCallsPerInvocation?: number;
  maxDurationMs?: number;
  toolAllowlist?: string[] | ((scope: string) => string[] | undefined);
  requireApproval?:
    | string[]
    | ((call: { scope: string; toolName: string; input: unknown }) => boolean);
  maxToolResultBytes?: number;
  /**
   * Per-execution usage budget, checked after each completed step.
   *
   * Enforcement is a circuit breaker, not a precise gate: the step that crosses
   * a limit completes (including its tool side effects), and only the next model
   * call is prevented. A crossing on a final text step is recorded but still
   * returns the answer. `maxCostUsd` is only enforceable when every step's cost
   * is known; token limits use known token counts as a lower bound. Budget stops
   * are final and are not retried.
   */
  budget?: RuntimeBudgetPolicy;
}
