export { defineRuntime } from './define-runtime';
export type {
  DatabaseHandle,
  DefineRuntimeOptions,
  Runtime,
} from './define-runtime';

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
  AiSdkNativeRuntime,
  TOOL_EXECUTION_CONTRACT,
  type AiSdkNativeRuntimeOptions,
} from './runtime/ai-sdk-runtime';
export { PolicyEngine, TOOL_PROPOSAL_CORRECTION } from './runtime/policy-engine';
export type { ParsedToolCall } from './runtime/policy-engine';
export {
  openAiCompatible,
  createAiSdkOpenAiCompatibleModel,
  type OpenAiCompatibleModelConfig,
} from './runtime/model';
export {
  NativeMcpClient,
  type NativeMcpClientConfig,
} from './mcp/native-mcp-client';
export { FakeAgentRuntime } from './fake-runtime';

export {
  RUNTIME_NAME,
  RUN_ID_HEADER,
  ERROR_CATEGORY_META_KEY,
} from './brand';
