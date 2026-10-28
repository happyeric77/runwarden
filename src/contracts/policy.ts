import type { z } from 'zod';

export interface ToolDefinition {
  /** Wire name, conventionally `<server>__<tool>`, e.g. `notes__search`. */
  name: string;
  description: string;
  inputSchema: z.ZodType;
  /** Schema-external validation; a returned correction is fed back to the model within the correction budget. */
  validateInput?: (
    input: unknown,
  ) => { ok: true } | { ok: false; correction: string };
}

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** Routing hint; without it, calls fall back to the first configured server. */
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
  /** At most one tool call per model step. Default `true`. */
  exactlyOneToolCallPerStep?: boolean;
  /** Correction turns per incident. Default `1`; a second violation fails the invocation. */
  correctionBudget?: number;
  /** Total executed tool calls per invocation. Default `8`. */
  maxToolCallsPerInvocation?: number;
  /** Wall-clock budget per invocation, in milliseconds. Default `120_000`. */
  maxDurationMs?: number;
  /** Static list or per-scope grant function. Off-list proposals are denied and recorded. */
  toolAllowlist?: string[] | ((scope: string) => string[] | undefined);
  /** Phase 1 is fail-closed: listed tools are denied, recorded as `approval_requested`, and fail the invocation with `code: 'approval_required'` until the approval state machine lands. */
  requireApproval?: string[];
  /** Per-call MCP tool-result size ceiling, in bytes. Default `32_768`. */
  maxToolResultBytes?: number;
}
