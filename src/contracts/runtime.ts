import type { AgentRuntimeError } from './errors.js';

export interface InvocationInput {
  scope: string;
  prompt: string;
  conversationId?: string;
  orderingKey?: string;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
}

export interface InvocationResult {
  invocationId: string;
  runId: string;
  text: string;
  provider?: string;
  model?: string;
}

export interface PendingToolCall {
  toolName: string;
  input: unknown;
}

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
  pendingToolCall?: PendingToolCall;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: Date;
  completedAt?: Date;
}

export type InvocationSettledListener = (
  invocation: InvocationRecord,
) => void | Promise<void>;

export interface NeutralMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type RuntimeInvocationInput = InvocationInput & {
  invocationId: string;
  runId: string;
  approvedToolCall?: PendingToolCall;
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
