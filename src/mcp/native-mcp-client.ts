import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  ERROR_CATEGORY_META_KEY,
  LEGACY_ERROR_CATEGORY_META_KEYS,
  RUN_ID_HEADER,
  RUNTIME_NAME,
} from '../brand';
import { AgentRuntimeError } from '../contracts/errors';
import type { McpToolClient, McpToolSession } from '../contracts/runtime';

export interface NativeMcpClientConfig {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResultBytes?: number;
}

// The MCP SDK signals its own request timeouts with ErrorCode.RequestTimeout
// (-32001) on an McpError, while aborts surface as AbortError/TimeoutError.
// Both mean "the MCP side did not answer in time", not "MCP is broken".
function isTimeoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    ['AbortError', 'TimeoutError'].includes(error.name) ||
    (error as Error & { code?: number }).code === -32_001
  );
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}

function isCorrectable(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  if (meta[ERROR_CATEGORY_META_KEY] === 'correctable') return true;
  // Migration compatibility: tool servers built against the pre-extraction
  // runtime mark correctable errors with the legacy meta key.
  return LEGACY_ERROR_CATEGORY_META_KEYS.some(
    (key) => meta[key] === 'correctable',
  );
}

/**
 * MCP client over Streamable HTTP. One session per invocation attempt,
 * correlated to its run by the run-id header; tool results are size-capped
 * and application errors marked `correctable` are returned to the model as
 * ordinary results so it can adjust within the same execution.
 */
export class NativeMcpClient implements McpToolClient {
  private readonly endpoint: URL;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxResultBytes: number;

  constructor(config: NativeMcpClientConfig) {
    this.endpoint = new URL(required(config.endpoint, 'endpoint'));
    if (!['http:', 'https:'].includes(this.endpoint.protocol)) {
      throw new Error('endpoint must use http or https');
    }
    this.headers = config.headers ?? {};
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxResultBytes = config.maxResultBytes ?? 32 * 1024;
    for (const [name, value] of [
      ['timeoutMs', this.timeoutMs],
      ['maxResultBytes', this.maxResultBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
  }

  async open(input: {
    runId: string;
    timeoutMs: number;
  }): Promise<McpToolSession> {
    const client = new Client({
      name: `${RUNTIME_NAME}-runtime`,
      version: '1',
    });
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: {
        headers: { ...this.headers, [RUN_ID_HEADER]: input.runId },
      },
    });
    try {
      await client.connect(transport, {
        timeout: Math.min(this.timeoutMs, input.timeoutMs),
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      if (isTimeoutFailure(error)) {
        throw new AgentRuntimeError('timeout', 'MCP connection timed out');
      }
      throw new AgentRuntimeError('failure', 'MCP connection failed');
    }

    return {
      callTool: async (call) => {
        try {
          const result = await client.callTool(
            { name: call.name, arguments: call.arguments },
            undefined,
            { timeout: Math.min(this.timeoutMs, call.timeoutMs) },
          );
          if (
            !Array.isArray(result.content) ||
            (result.isError && !isCorrectable(result._meta))
          ) {
            throw new AgentRuntimeError('failure', 'MCP tool call failed');
          }
          const serialized = JSON.stringify(result.content);
          if (Buffer.byteLength(serialized, 'utf8') > this.maxResultBytes) {
            throw new AgentRuntimeError(
              'failure',
              'MCP tool result exceeded limit',
            );
          }
          return serialized;
        } catch (error) {
          if (error instanceof AgentRuntimeError) throw error;
          if (isTimeoutFailure(error)) {
            throw new AgentRuntimeError('timeout', 'MCP tool call timed out');
          }
          throw new AgentRuntimeError('failure', 'MCP tool call failed');
        }
      },
      close: () => client.close(),
    };
  }
}
