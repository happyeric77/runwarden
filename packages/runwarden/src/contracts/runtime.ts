import type { JSONValue } from 'ai';

import type { AgentRuntimeError } from './errors.js';
import type { BudgetExceededLimit, BudgetGrant } from './policy.js';

export interface InvocationInput {
  scope: string;
  prompt: string;
  runId?: string;
  conversationId?: string;
  orderingKey?: string;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
}

export interface UsageTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface UsageStep extends UsageTokenCounts {
  provider?: string;
  model: string;
  usageKnown: boolean;
  costUsd?: number;
  costKnown: boolean;
}

export interface InvocationUsage extends UsageTokenCounts {
  costUsd?: number;
  costIncomplete: boolean;
  steps: UsageStep[];
}

export interface UsagePriceOverride {
  provider?: string;
  model: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cacheReadPerMillionTokens?: number;
  cacheWritePerMillionTokens?: number;
}

export interface UsagePricingOptions {
  providerId?: string;
  overrides?: readonly UsagePriceOverride[];
}

export interface InvocationResult {
  invocationId: string;
  runId: string;
  text: string;
  messages: NeutralMessage[];
  usage: InvocationUsage;
  provider?: string;
  model?: string;
}

export interface PendingToolCall {
  toolName: string;
  input: unknown;
}

/**
 * A durable budget park. `requestId` is the parked run ID and must be supplied
 * when the park is resolved so a stale decision cannot touch a newer park.
 */
export interface BudgetRequest {
  requestId: string;
  limits: BudgetExceededLimit[];
  usage: InvocationUsage;
}

export type AwaitingApprovalRequest =
  | { kind: 'tool'; toolCall: PendingToolCall }
  | { kind: 'budget'; budgetRequest: BudgetRequest };

export type InvocationStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface InvocationRecord extends InvocationInput {
  id: string;
  status: InvocationStatus;
  attemptCount: number;
  resultText?: string;
  pendingApprovalKind?: 'tool' | 'budget';
  pendingToolCall?: PendingToolCall;
  pendingBudgetRequest?: BudgetRequest;
  budgetGrants?: BudgetGrant;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: Date;
  completedAt?: Date;
}

export type InvocationSettledListener = (
  invocation: InvocationRecord,
) => void | Promise<void>;

export interface NeutralTextPart {
  type: 'text';
  text: string;
}

export interface NeutralToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type NeutralToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: JSONValue }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: JSONValue }
  | { type: 'execution-denied'; reason?: string };

export interface NeutralToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: NeutralToolResultOutput;
}

export type NeutralContentPart = NeutralTextPart | NeutralToolCallPart;

/**
 * A plain text message (the original shape) is still a valid NeutralMessage, so
 * existing history loaders and callers compile and behave unchanged.
 */
export type NeutralMessage =
  | { role: 'user' | 'system'; content: string }
  | { role: 'assistant'; content: string | readonly NeutralContentPart[] }
  | { role: 'tool'; content: readonly NeutralToolResultPart[] };

export type RuntimeInvocationInput = InvocationInput & {
  invocationId: string;
  runId: string;
  approvedToolCall?: PendingToolCall;
  /** Accumulated quota granted through budget approvals for this invocation. */
  budgetGrants?: BudgetGrant;
  /** Set only on the durable execution path, where a park can be approved. */
  budgetParkable?: boolean;
};

export interface AgentRuntime {
  invoke(input: RuntimeInvocationInput): Promise<InvocationResult>;
}

export type SystemPromptLoader = (
  input: RuntimeInvocationInput,
) => Promise<string>;

export type HistoryLoader = (
  input: RuntimeInvocationInput,
) => Promise<readonly NeutralMessage[]>;

export interface McpToolSession {
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    timeoutMs: number;
    idempotencyKey?: string;
  }): Promise<string>;
  close(): Promise<void>;
}

export interface ToolCallAuditEvent {
  dispatchId: string;
  phase: 'started' | 'succeeded' | 'failed';
  scope: string;
  invocationId: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  idempotencyKey: string;
  input: unknown;
  errorCode?: string;
}

export type ToolCallAuditSink = (
  event: ToolCallAuditEvent,
) => Promise<void> | void;

export interface McpToolClient {
  open(input: { runId: string; timeoutMs: number }): Promise<McpToolSession>;
}

export interface RuntimeMetrics {
  runId: string;
  contextLoadMs: number;
  historyLoadMs: number;
  providerCallCount: number;
  toolCallCount: number;
  totalProviderMs: number;
  totalToolMs: number;
  totalMs: number;
}

export type { AgentRuntimeError };
