import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDb } from 'runwarden';
import { z } from 'zod';

import {
  cancelOrder,
  deleteCustomer,
  ensureShopSchema,
  getCustomer,
  getOrder,
  issueRefund,
  listCustomers,
  listOrders,
  listProducts,
  sendEmailToCustomer,
} from './shop.js';
import {
  cancelOrderInput,
  deleteCustomerInput,
  getCustomerInput,
  getOrderInput,
  issueRefundInput,
  listOrdersInput,
  sendEmailToCustomerInput,
  tools,
} from './tools.js';

export interface PlaygroundMcpServer {
  url: string;
  close(): Promise<void>;
}

export async function startPlaygroundMcpServer(
  port: number,
): Promise<PlaygroundMcpServer> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const handle = createDb(databaseUrl);
  await ensureShopSchema(handle.pool);

  const httpServer = createServer(async (request, response) => {
    const server = buildServer(handle.pool);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  try {
    await new Promise<void>((resolve) =>
      httpServer.listen(port, '127.0.0.1', resolve),
    );
  } catch (error) {
    await handle.close();
    throw error;
  }
  const bound = httpServer.address();
  if (!bound || typeof bound === 'string') {
    httpServer.close();
    await handle.close();
    throw new Error('mcp server did not bind a port');
  }
  return {
    url: `http://127.0.0.1:${bound.port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      await handle.close();
    },
  };
}

function buildServer(pool: import('pg').Pool): McpServer {
  const server = new McpServer({
    name: 'governance-playground',
    version: '1',
  });
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {
    list_orders: (args) => listOrders(pool, listOrdersInput.parse(args)),
    get_order: (args) => getOrder(pool, getOrderInput.parse(args)),
    list_customers: () => listCustomers(pool),
    get_customer: (args) => getCustomer(pool, getCustomerInput.parse(args)),
    list_products: () => listProducts(pool),
    issue_refund: (args) => issueRefund(pool, issueRefundInput.parse(args)),
    send_email_to_customer: (args) =>
      sendEmailToCustomer(pool, sendEmailToCustomerInput.parse(args)),
    cancel_order: (args) => cancelOrder(pool, cancelOrderInput.parse(args)),
    delete_customer: (args) =>
      deleteCustomer(pool, deleteCustomerInput.parse(args)),
  };
  for (const tool of tools) {
    const handler = handlers[tool.name];
    if (!handler) throw new Error(`missing handler: ${tool.name}`);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: zodShape(tool.inputSchema),
      },
      async (args) => ({
        content: [
          { type: 'text' as const, text: JSON.stringify(await handler(args)) },
        ],
      }),
    );
  }
  return server;
}

function zodShape(schema: z.ZodType): z.ZodRawShape {
  if (schema instanceof z.ZodEffects) return zodShape(schema.innerType());
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('tool inputSchema must be an object');
  }
  return schema.shape;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.MCP_PORT ?? 43_122);
  const server = await startPlaygroundMcpServer(port);
  console.log(`[mcp] governance playground listening at ${server.url}`);
}
