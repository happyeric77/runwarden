import type { z } from 'zod';

/**
 * A tool the model may propose. Tools are executed through MCP
 * (ADR-007); the definition supplies the model-facing description and
 * schema plus an optional input validator.
 */
export interface ToolDefinition {
  /** Wire name, conventionally `<server>__<tool>`, e.g. `notes__search`. */
  name: string;
  description: string;
  /** Usually a `z.object({...})`; refinements are honored. */
  inputSchema: z.ZodType;
  /**
   * Domain-level input validation that schema checks cannot express.
   * When a proposed call fails schema validation, the runtime asks this
   * hook (with blank-normalized input) whether the mistake is correctable;
   * a returned `correction` is fed back to the model inside the
   * correction budget instead of failing the invocation.
   */
  validateInput?: (
    input: unknown,
  ) => { ok: true } | { ok: false; correction: string };
}

export interface McpServerConfig {
  name: string;
  /** Streamable HTTP endpoint. */
  url: string;
  headers?: Record<string, string>;
  /**
   * Tool names served by this server. Used to route calls when more than
   * one server is configured; without a hint, calls fall back to the
   * first configured server.
   */
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

/** One policy ruling on the tool-call path, as recorded for audit. */
export interface PolicyDecision {
  scope: string;
  invocationId: string;
  runId: string;
  rule: PolicyRule;
  decision: PolicyDecisionKind;
  toolName?: string;
  detail?: Record<string, unknown>;
}

/**
 * Declarative tool-call policy (ADR-004). Policy is enforced by the
 * runtime on the execution path — never by asking the model nicely.
 * The prompt-level execution contract is only the weakest of three
 * layers and can be switched off with the rest of `exactlyOneToolCallPerStep`.
 */
export interface RuntimePolicies {
  /**
   * At most one tool call per model step. Default `true`.
   * Enforced via the prompt contract, `parallel_tool_calls: false`, and
   * execution-path denial of multi-call steps.
   */
  exactlyOneToolCallPerStep?: boolean;
  /**
   * Correction turns allowed per policy incident. Default `1`:
   * a violating step earns exactly one chance to correct itself; a
   * second violation in the same incident fails the invocation.
   */
  correctionBudget?: number;
  /** Total executed tool calls per invocation. Default `8`. */
  maxToolCallsPerInvocation?: number;
  /** Wall-clock budget per invocation, in milliseconds. Default `120_000`. */
  maxDurationMs?: number;
  /**
   * Tool names the model may call at all. Proposals outside the list are
   * denied before execution and recorded as policy decisions. Either a
   * static list or a per-scope grant function (ADR-010).
   */
  toolAllowlist?: string[] | ((scope: string) => string[] | undefined);
  /**
   * Tool names that require human approval before execution.
   *
   * Phase 1 reserves the configuration surface and the interception
   * point: a proposal for a listed tool is denied, recorded as
   * `approval_requested`, and fails the invocation with
   * `code: 'approval_required'`. The durable `awaiting_approval` state
   * machine (ADR-011) lands in a later slice and replaces the failure
   * with a resumable pause.
   */
  requireApproval?: string[];
  /** Per-call MCP tool-result size ceiling, in bytes. Default `32_768`. */
  maxToolResultBytes?: number;
}
