export { defineRuntime } from './define-runtime';
export type {
  DatabaseHandle,
  DefineRuntimeOptions,
  InvokeOptions,
  Runtime,
} from './define-runtime';

export { createDb } from './db/client';
export { initDb, type InitOptions, type InitResult } from './db/init';
export {
  runWorker,
  type RunWorkerOptions,
  type WorkerHandle,
} from './worker/run-worker';

export {
  AgentRuntimeError,
  type AgentRuntimeErrorKind,
} from './contracts/errors';

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
  RuntimeInvocationInput,
  RuntimeMetrics,
  SystemPromptLoader,
} from './contracts/runtime';

export type {
  McpServerConfig,
  PolicyDecision,
  PolicyDecisionKind,
  PolicyRule,
  RuntimePolicies,
  ToolDefinition,
} from './contracts/policy';

export {
  openAiCompatible,
  type OpenAiCompatibleModelConfig,
} from './runtime/model';
export {
  NativeMcpClient,
  type NativeMcpClientConfig,
} from './mcp/native-mcp-client';
export { FakeAgentRuntime } from './fake-runtime';

export { RUNTIME_NAME, RUN_ID_HEADER, ERROR_CATEGORY_META_KEY } from './brand';
