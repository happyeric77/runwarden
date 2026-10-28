import { MockLanguageModelV4 } from 'ai/test';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as api from './index';
import { NativeMcpClient } from './mcp/native-mcp-client';

it.each([0, 1])(
  'closes every successful session when server %i fails to open',
  async (failedIndex) => {
    const failure = new api.AgentRuntimeError(
      'failure',
      'MCP connection failed',
    );
    const close = vi.fn().mockRejectedValue(new Error('close failed'));
    const callTool = vi.fn();
    const open = vi.spyOn(NativeMcpClient.prototype, 'open');
    for (let index = 0; index < 2; index++) {
      open.mockImplementationOnce(async () => {
        if (index === failedIndex) throw failure;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { callTool, close };
      });
    }
    try {
      const runtime = api.defineRuntime({
        model: new MockLanguageModelV4({
          doGenerate: async () => ({
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call',
                toolName: 'notes__get',
                input: '{}',
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          }),
        }),
        tools: [
          {
            name: 'notes__get',
            description: 'Get a note',
            inputSchema: z.object({}),
          },
        ],
        mcpServers: [
          { name: 'first', url: 'http://first.invalid/mcp' },
          { name: 'second', url: 'http://second.invalid/mcp' },
        ],
      });
      await expect(
        runtime.invoke({ scope: 'scope-a', prompt: 'Get a note' }),
      ).rejects.toBe(failure);
      expect(open).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledOnce();
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  },
);

it('keeps loop and policy implementation details out of the public API', () => {
  for (const name of [
    'AiSdkNativeRuntime',
    'PolicyEngine',
    'TOOL_EXECUTION_CONTRACT',
    'TOOL_PROPOSAL_CORRECTION',
    'createAiSdkOpenAiCompatibleModel',
  ]) {
    expect(api).not.toHaveProperty(name);
  }
  expect(api.defineRuntime).toBeTypeOf('function');
});
