import { randomUUID } from 'node:crypto';

import type { LanguageModel } from 'ai';

import { AgentRuntimeError } from './contracts/errors';
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
  InvocationRecord,
  InvocationResult,
  McpToolClient,
  McpToolSession,
  RuntimeMetrics,
  SystemPromptLoader,
} from './contracts/runtime';
import type { DatabaseHandle } from './db/client';
import {
  enqueueInvocation,
  getInvocationRowById,
  toRecord,
} from './db/repositories/invocations';
import { NativeMcpClient } from './mcp/native-mcp-client';
import { AiSdkNativeRuntime } from './runtime/ai-sdk-runtime';
import {
  openAiCompatible,
  type OpenAiCompatibleModelConfig,
} from './runtime/model';

export type { DatabaseHandle } from './db/client';

// Keep worker subscriptions off the public package surface.
export const RUNTIME_INTERNALS: unique symbol = Symbol('runwarden/internals');

export interface RuntimeInternals {
  onPolicyDecision(listener: (decision: PolicyDecision) => void): () => void;
}

export interface DefineRuntimeOptions {
  db?: DatabaseHandle;
  model?: LanguageModel;
  provider?: OpenAiCompatibleModelConfig;
  tools?: ToolDefinition[];
  mcpServers?: McpServerConfig[];
  mcpClient?: McpToolClient;
  loadSystemPrompt?: SystemPromptLoader;
  loadHistory?: HistoryLoader;
  policies?: RuntimePolicies;
  onMetrics?: (metrics: RuntimeMetrics) => void;
  onPolicyDecision?: (decision: PolicyDecision) => void;
}

export interface InvokeOptions {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface Runtime {
  invoke(
    input: InvocationInput,
    opts?: InvokeOptions,
  ): Promise<InvocationResult>;
  enqueue(input: InvocationInput): Promise<{ invocationId: string }>;
  getInvocation(id: string): Promise<InvocationRecord | undefined>;
  readonly engine: AgentRuntime;
  readonly [RUNTIME_INTERNALS]?: RuntimeInternals;
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
    const opened = await Promise.allSettled(
      this.clients.map((client) => client.open(input)),
    );
    const sessions = opened.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failure = opened.find((result) => result.status === 'rejected');
    if (failure) {
      await Promise.allSettled(sessions.map((session) => session.close()));
      throw failure.reason;
    }
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dbRequired(operation: string): AgentRuntimeError {
  return new AgentRuntimeError(
    'failure',
    `${operation} requires a database: pass createDb() as defineRuntime({ db })`,
    { code: 'db_required' },
  );
}

export function defineRuntime(options: DefineRuntimeOptions): Runtime {
  const model =
    options.model ??
    (options.provider ? openAiCompatible(options.provider) : undefined);
  if (!model) {
    throw new Error('defineRuntime requires either `model` or `provider`');
  }

  const mcpClient =
    options.mcpClient ?? buildMcpClient(options.mcpServers, options.policies);

  const decisionListeners = new Set<(decision: PolicyDecision) => void>();
  const engine = new AiSdkNativeRuntime({
    model,
    tools: options.tools,
    mcpClient,
    loadSystemPrompt: options.loadSystemPrompt,
    loadHistory: options.loadHistory,
    policies: options.policies,
    onMetrics: options.onMetrics,
    onPolicyDecision: (decision) => {
      for (const listener of decisionListeners) listener(decision);
      options.onPolicyDecision?.(decision);
    },
  });

  const db = options.db;

  async function durableInvoke(
    input: InvocationInput,
    opts?: InvokeOptions,
  ): Promise<InvocationResult> {
    const { invocationId } = await enqueueInvocation(db!.db, input);
    const deadline = Date.now() + (opts?.waitTimeoutMs ?? 300_000);
    const pollIntervalMs = opts?.pollIntervalMs ?? 250;
    for (;;) {
      const row = await getInvocationRowById(db!.db, invocationId);
      if (row?.status === 'succeeded') {
        return {
          invocationId,
          runId: row.activeRunId!,
          text: row.resultText ?? '',
          provider: row.provider ?? undefined,
          model: row.model ?? undefined,
        };
      }
      if (row?.status === 'failed' || row?.status === 'cancelled') {
        throw new AgentRuntimeError(
          'failure',
          row.lastErrorMessage ?? `Invocation ${row.status}`,
          {
            code: row.lastErrorCode ?? `invocation_${row.status}`,
            invocationId,
          },
        );
      }
      if (Date.now() >= deadline) {
        // A caller's wait deadline must not cancel durable work.
        throw new AgentRuntimeError(
          'timeout',
          `Timed out waiting for invocation ${invocationId}`,
          { invocationId },
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    engine,
    invoke: db
      ? durableInvoke
      : (input) =>
          engine.invoke({
            ...input,
            invocationId: randomUUID(),
            runId: randomUUID(),
          }),
    enqueue: async (input) => {
      if (!db) throw dbRequired('enqueue');
      return enqueueInvocation(db.db, input);
    },
    getInvocation: async (id) => {
      if (!db) throw dbRequired('getInvocation');
      const row = await getInvocationRowById(db.db, id);
      return row ? toRecord(row) : undefined;
    },
    [RUNTIME_INTERNALS]: {
      onPolicyDecision: (listener) => {
        decisionListeners.add(listener);
        return () => {
          decisionListeners.delete(listener);
        };
      },
    },
  };
}
