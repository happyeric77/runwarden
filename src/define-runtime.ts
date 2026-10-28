import { randomUUID } from 'node:crypto';

import type { LanguageModel } from 'ai';

import type {
  McpServerConfig,
  PolicyDecision,
  RuntimePolicies,
  ToolDefinition,
} from './contracts/policy';
import type {
  AgentRuntime,
  HistoryLoader,
  InvocationInput,
  InvocationResult,
  McpToolClient,
  McpToolSession,
  RuntimeMetrics,
  SystemPromptLoader,
} from './contracts/runtime';
import { NativeMcpClient } from './mcp/native-mcp-client';
import { AiSdkNativeRuntime } from './runtime/ai-sdk-runtime';
import {
  openAiCompatible,
  type OpenAiCompatibleModelConfig,
} from './runtime/model';

/**
 * Opaque handle for the runtime's database, as returned by `createDb()`.
 * The durable queue, schema, and worker that consume it land with the
 * database phase; in this phase `db` is accepted and carried, while
 * execution runs in-process through `Runtime.invoke`.
 */
export interface DatabaseHandle {
  readonly kind: 'durable-agent-runtime/database';
}

export interface DefineRuntimeOptions {
  db?: DatabaseHandle;
  /** An AI SDK language model. Takes precedence over `provider`. */
  model?: LanguageModel;
  /** Convenience: build the model from an OpenAI-compatible endpoint config. */
  provider?: OpenAiCompatibleModelConfig;
  /** Registered tools (definitions + validation); executed through MCP. */
  tools?: ToolDefinition[];
  /** MCP servers to execute tool calls against (ADR-007). */
  mcpServers?: McpServerConfig[];
  /** Escape hatch: bring your own MCP client instead of `mcpServers`. */
  mcpClient?: McpToolClient;
  loadSystemPrompt?: SystemPromptLoader;
  loadHistory?: HistoryLoader;
  policies?: RuntimePolicies;
  onMetrics?: (metrics: RuntimeMetrics) => void;
  onPolicyDecision?: (decision: PolicyDecision) => void;
}

export interface Runtime {
  /** Execute one invocation now, in-process, and return its result. */
  invoke(input: InvocationInput): Promise<InvocationResult>;
  /** The stable execution engine (ADR-008); the worker consumes this. */
  readonly engine: AgentRuntime;
}

function buildMcpClient(
  servers: McpServerConfig[] | undefined,
  policies: RuntimePolicies | undefined,
): McpToolClient | undefined {
  if (!servers || servers.length === 0) return undefined;
  const clients = servers.map(
    (server) =>
      new NativeMcpClient({
        endpoint: server.url,
        headers: server.headers,
        maxResultBytes: policies?.maxToolResultBytes,
      }),
  );
  if (clients.length === 1) return clients[0];
  // Multiple servers: sessions open against every server; per-tool
  // routing by the servers' `tools` hints is applied by callTool below.
  return new RoutingMcpClient(clients, servers);
}

class RoutingMcpClient implements McpToolClient {
  constructor(
    private readonly clients: readonly NativeMcpClient[],
    private readonly servers: readonly McpServerConfig[],
  ) {}

  async open(input: {
    runId: string;
    timeoutMs: number;
  }): Promise<McpToolSession> {
    const sessions = await Promise.all(
      this.clients.map((client) => client.open(input)),
    );
    const route = (toolName: string): McpToolSession => {
      const index = this.servers.findIndex((server) =>
        server.tools?.includes(toolName),
      );
      return sessions[index >= 0 ? index : 0]!;
    };
    return {
      callTool: (call) => route(call.name).callTool(call),
      close: async () => {
        await Promise.allSettled(sessions.map((session) => session.close()));
      },
    };
  }
}

/**
 * Assemble a runtime: the single entry point host applications use.
 *
 * ```ts
 * const runtime = defineRuntime({
 *   provider: { baseUrl, apiKey, model },
 *   mcpServers: [{ name: 'notes', url: 'http://localhost:43120/mcp' }],
 *   tools: [notesSearchTool, notesGetTool],
 *   policies: { requireApproval: ['billing__refund'] },
 * });
 * const result = await runtime.invoke({ scope: 'tenant-a', prompt: '...' });
 * ```
 */
export function defineRuntime(options: DefineRuntimeOptions): Runtime {
  const model =
    options.model ??
    (options.provider ? openAiCompatible(options.provider) : undefined);
  if (!model) {
    throw new Error('defineRuntime requires either `model` or `provider`');
  }

  const mcpClient =
    options.mcpClient ?? buildMcpClient(options.mcpServers, options.policies);

  const engine = new AiSdkNativeRuntime({
    model,
    tools: options.tools,
    mcpClient,
    loadSystemPrompt: options.loadSystemPrompt,
    loadHistory: options.loadHistory,
    policies: options.policies,
    onMetrics: options.onMetrics,
    onPolicyDecision: options.onPolicyDecision,
  });

  return {
    engine,
    invoke: (input) =>
      engine.invoke({
        ...input,
        invocationId: randomUUID(),
        runId: randomUUID(),
      }),
  };
}
