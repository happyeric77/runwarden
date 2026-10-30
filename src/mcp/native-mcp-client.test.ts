import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { IDEMPOTENCY_KEY_META_KEY, RUN_ID_HEADER } from '../brand.js';
import { NativeMcpClient } from './native-mcp-client.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function startServer(register: (server: McpServer) => void) {
  let lastRunId: string | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  const httpServer = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      lastRunId = request.headers[RUN_ID_HEADER.toLowerCase()] as
        | string
        | undefined;
      const server = new McpServer({ name: 'test-server', version: '1' });
      register(server);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    },
  );
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  closers.push(async () => {
    await transport?.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    getLastRunId: () => lastRunId,
  };
}

describe('NativeMcpClient', () => {
  it('calls a real Streamable HTTP MCP tool with the invocation run id', async () => {
    const { endpoint, getLastRunId } = await startServer((server) => {
      server.registerTool(
        'ping',
        { inputSchema: { value: z.string() } },
        async ({ value }) => ({
          content: [{ type: 'text', text: `pong:${value}` }],
        }),
      );
    });
    const client = new NativeMcpClient({ endpoint });
    const session = await client.open({ runId: 'run-123', timeoutMs: 5_000 });

    await expect(
      session.callTool({
        name: 'ping',
        arguments: { value: 'hello' },
        timeoutMs: 5_000,
      }),
    ).resolves.toContain('pong:hello');
    expect(getLastRunId()).toBe('run-123');
    await session.close();
  });

  it('returns a correctable MCP application error for model correction', async () => {
    const { endpoint } = await startServer((server) => {
      server.registerTool(
        'validate',
        { inputSchema: { value: z.string() } },
        async () => ({
          isError: true,
          _meta: { 'runwarden/error-category': 'correctable' },
          content: [{ type: 'text', text: 'Try a corrected value.' }],
        }),
      );
    });
    const client = new NativeMcpClient({ endpoint });
    const session = await client.open({ runId: 'run-123', timeoutMs: 5_000 });

    await expect(
      session.callTool({
        name: 'validate',
        arguments: { value: 'bad' },
        timeoutMs: 5_000,
      }),
    ).resolves.toContain('Try a corrected value.');
    await session.close();
  });

  it('sends the call idempotency key as request meta when provided', async () => {
    let seenMeta: Record<string, unknown> | undefined;
    const { endpoint } = await startServer((server) => {
      server.registerTool(
        'ping',
        { inputSchema: { value: z.string() } },
        async ({ value }, extra) => {
          seenMeta = extra._meta as Record<string, unknown> | undefined;
          return { content: [{ type: 'text', text: `pong:${value}` }] };
        },
      );
    });
    const client = new NativeMcpClient({ endpoint });
    const session = await client.open({ runId: 'run-123', timeoutMs: 5_000 });

    await session.callTool({
      name: 'ping',
      arguments: { value: 'hello' },
      timeoutMs: 5_000,
      idempotencyKey: 'key-abc',
    });
    expect(seenMeta?.[IDEMPOTENCY_KEY_META_KEY]).toBe('key-abc');

    await session.callTool({
      name: 'ping',
      arguments: { value: 'again' },
      timeoutMs: 5_000,
    });
    expect(seenMeta?.[IDEMPOTENCY_KEY_META_KEY]).toBeUndefined();
    await session.close();
  });

  it('fails non-correctable MCP application errors', async () => {
    const { endpoint } = await startServer((server) => {
      server.registerTool(
        'fail',
        { inputSchema: { value: z.string() } },
        async () => ({
          isError: true,
          content: [{ type: 'text', text: 'No' }],
        }),
      );
    });
    const client = new NativeMcpClient({ endpoint });
    const session = await client.open({ runId: 'run-123', timeoutMs: 5_000 });

    await expect(
      session.callTool({
        name: 'fail',
        arguments: { value: 'bad' },
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ message: 'MCP tool call failed' });
    await session.close();
  });

  it('classifies a slow MCP tool call as a timeout, not a generic failure', async () => {
    const { endpoint } = await startServer((server) => {
      server.registerTool(
        'slow',
        { inputSchema: { value: z.string() } },
        async ({ value }) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { content: [{ type: 'text', text: value }] };
        },
      );
    });
    const client = new NativeMcpClient({ endpoint, timeoutMs: 50 });
    const session = await client.open({ runId: 'run-123', timeoutMs: 5_000 });

    await expect(
      session.callTool({
        name: 'slow',
        arguments: { value: 'late' },
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      kind: 'timeout',
      message: 'MCP tool call timed out',
    });
    await session.close();
  });
});
