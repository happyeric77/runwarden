import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  ERROR_CATEGORY_META_KEY,
  IDEMPOTENCY_KEY_META_KEY,
  RUN_ID_HEADER,
  RUNTIME_NAME,
} from '../brand.js';
import { AgentRuntimeError } from '../contracts/errors.js';
import type { McpToolClient, McpToolSession } from '../contracts/runtime.js';

export interface NativeMcpClientConfig {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResultBytes?: number;
}

// SDK and transport timeouts must share the timeout error classification.
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
  return meta?.[ERROR_CATEGORY_META_KEY] === 'correctable';
}

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
            {
              name: call.name,
              arguments: call.arguments,
              ...(call.idempotencyKey
                ? {
                    _meta: {
                      [IDEMPOTENCY_KEY_META_KEY]: call.idempotencyKey,
                    },
                  }
                : {}),
            },
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
