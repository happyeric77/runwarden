import type { AgentRuntimeError } from './errors';

/**
 * One unit of agent work, as the host application describes it.
 *
 * `scope` is the single isolation key (ADR-010): it replaces any tenant /
 * user / agent id the host might otherwise model. The library never learns
 * what a scope means; it only guarantees isolation and capability grants
 * are evaluated per scope.
 */
export interface InvocationInput {
  scope: string;
  /** The user message / task prompt for this invocation. */
  prompt: string;
  /** Opaque conversation identifier owned by the host, if any. */
  conversationId?: string;
  /** Invocations sharing an ordering key run serially, in enqueue order. */
  orderingKey?: string;
  /** Arbitrary host context, stored with the invocation input. */
  context?: Record<string, unknown>;
  /** Enqueue-level deduplication key (unique per scope). */
  idempotencyKey?: string;
  /** Delivery attempts before the invocation is failed permanently. */
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
}

export interface InvocationResult {
  invocationId: string;
  /** One run id per attempt; a retried invocation gets a fresh run id. */
  runId: string;
  text: string;
  provider?: string;
  model?: string;
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
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: Date;
  completedAt?: Date;
}

/** A framework-neutral chat message, as returned by history loaders. */
export interface NeutralMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** The full input an execution engine receives for one attempt. */
export type RuntimeInvocationInput = InvocationInput & {
  invocationId: string;
  runId: string;
};

/**
 * The stable execution contract (ADR-008). `runWorker` consumes an
 * `AgentRuntime`; host applications normally go through `defineRuntime`
 * instead of implementing this themselves.
 */
export interface AgentRuntime {
  invoke(input: RuntimeInvocationInput): Promise<InvocationResult>;
}

export type SystemPromptLoader = (
  input: RuntimeInvocationInput,
) => Promise<string>;

export type HistoryLoader = (
  input: RuntimeInvocationInput,
) => Promise<readonly NeutralMessage[]>;

/** One open connection to an MCP tool server, bound to a single run. */
export interface McpToolSession {
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<string>;
  close(): Promise<void>;
}

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
