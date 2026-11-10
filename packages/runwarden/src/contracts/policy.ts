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
  | 'correction_budget';

export type PolicyDecisionKind =
  | 'allow'
  | 'deny'
  | 'correction_issued'
  | 'approval_requested'
  | 'approved'
  | 'rejected';

export interface PolicyDecision {
  scope: string;
  invocationId: string;
  runId: string;
  rule: PolicyRule;
  decision: PolicyDecisionKind;
  toolName?: string;
  detail?: Record<string, unknown>;
}

export interface RuntimePolicies {
  exactlyOneToolCallPerStep?: boolean;
  correctionBudget?: number;
  maxToolCallsPerInvocation?: number;
  maxDurationMs?: number;
  toolAllowlist?: string[] | ((scope: string) => string[] | undefined);
  requireApproval?: string[];
  maxToolResultBytes?: number;
}
