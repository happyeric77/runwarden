import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const NOTES: Record<string, string> = {
  roadmap: 'Roadmap note: "Ship the runtime first, add features later."',
  handbook: 'Handbook note: "Office hours are 10:00-16:00, Monday to Friday."',
};

function buildServer(): McpServer {
  const server = new McpServer({ name: 'runwarden-quickstart', version: '1' });
  server.registerTool(
    'notes__search',
    {
      description: 'Search the notes collection by keyword.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const q = query.trim().toLowerCase();
      const match =
        NOTES[q] ??
        Object.entries(NOTES).find(
          ([key, text]) => q.includes(key) || text.toLowerCase().includes(q),
        )?.[1];
      return {
        content: [
          { type: 'text' as const, text: match ?? 'No matching note.' },
        ],
      };
    },
  );
  server.registerTool(
    'billing__refund',
    {
      description: 'Refund a charge to the original payment method.',
      inputSchema: {
        amountCents: z.number().int().positive(),
        reason: z.string().min(1),
      },
    },
    async ({ amountCents, reason }) => ({
      content: [
        {
          type: 'text' as const,
          text: `Refund of ${amountCents} cents issued (${reason}).`,
        },
      ],
    }),
  );
  return server;
}

export interface QuickstartMcpServer {
  url: string;
  close(): Promise<void>;
}

export async function startQuickstartMcpServer(
  port: number,
): Promise<QuickstartMcpServer> {
  const httpServer = createServer(async (request, response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(port, '127.0.0.1', resolve),
  );
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.MCP_PORT ?? 43_121);
  const server = await startQuickstartMcpServer(port);
  console.log(`[mcp] quickstart tool server listening at ${server.url}`);
}
