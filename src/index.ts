export { defineRuntime } from './define-runtime.js';
export type {
  ApprovalActionOptions,
  DatabaseHandle,
  DefineRuntimeOptions,
  InvokeOptions,
  Runtime,
} from './define-runtime.js';

export { createDb } from './db/client.js';
export { initDb, type InitOptions, type InitResult } from './db/init.js';
export {
  runWorker,
  type RunWorkerOptions,
  type WorkerHandle,
} from './worker/run-worker.js';

export {
  AgentRuntimeError,
  type AgentRuntimeErrorKind,
} from './contracts/errors.js';

export type {
  AgentRuntime,
  HistoryLoader,
  InvocationInput,
  InvocationRecord,
  InvocationResult,
  InvocationStatus,
  McpToolClient,
  McpToolSession,
  NeutralMessage,
  PendingToolCall,
  RuntimeInvocationInput,
  RuntimeMetrics,
  SystemPromptLoader,
  ToolCallAuditEvent,
  ToolCallAuditSink,
} from './contracts/runtime.js';

export type {
  McpServerConfig,
  PolicyDecision,
  PolicyDecisionKind,
  PolicyRule,
  RuntimePolicies,
  ToolDefinition,
} from './contracts/policy.js';

export {
  openAiCompatible,
  type OpenAiCompatibleModelConfig,
} from './runtime/model.js';
export {
  NativeMcpClient,
  type NativeMcpClientConfig,
} from './mcp/native-mcp-client.js';
export { FakeAgentRuntime } from './fake-runtime.js';

export {
  RUNTIME_NAME,
  RUN_ID_HEADER,
  ERROR_CATEGORY_META_KEY,
} from './brand.js';
