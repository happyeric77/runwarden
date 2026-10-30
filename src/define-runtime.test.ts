import { MockLanguageModelV4 } from 'ai/test';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import { RUNTIME_INTERNALS } from './define-runtime.js';
import * as api from './index.js';
import { NativeMcpClient } from './mcp/native-mcp-client.js';

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

it.each([false, true])(
  'routes audit events before observers and preserves the MCP key, persistence fails: %s',
  async (failPersistence) => {
    const order: string[] = [];
    const calls = [
      vi.fn().mockResolvedValue('ok'),
      vi.fn().mockResolvedValue('ok'),
    ];
    const open = vi.spyOn(NativeMcpClient.prototype, 'open');
    for (const callTool of calls)
      open.mockResolvedValueOnce({ callTool, close: async () => {} });
    let step = 0;
    try {
      const runtime = api.defineRuntime({
        model: new MockLanguageModelV4({
          doGenerate: async () => ({
            content:
              step++ === 0
                ? [
                    {
                      type: 'tool-call',
                      toolCallId: 'call',
                      toolName: 'notes__get',
                      input: '{}',
                    },
                  ]
                : [{ type: 'text', text: 'Done' }],
            finishReason: { unified: 'stop', raw: 'stop' },
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
          { name: 'first', url: 'http://first.invalid' },
          {
            name: 'second',
            url: 'http://second.invalid',
            tools: ['notes__get'],
          },
        ],
        onToolCallAudit: (event) => {
          order.push(`observer:${event.phase}`);
          throw new Error('observer failed');
        },
      });
      runtime[RUNTIME_INTERNALS]!.onToolCallAudit!(async (event) => {
        order.push(`persist:${event.phase}`);
        if (failPersistence) throw new Error('database failed');
      });
      if (failPersistence) {
        await expect(
          runtime.invoke({ scope: 'test', prompt: 'test' }),
        ).rejects.toMatchObject({
          diagnostics: { code: 'audit_persistence_failed' },
        });
        expect(order).toEqual(['persist:started']);
        expect(open).not.toHaveBeenCalled();
      } else {
        await expect(
          runtime.invoke({ scope: 'test', prompt: 'test' }),
        ).resolves.toMatchObject({ text: 'Done' });
        expect(order).toEqual([
          'persist:started',
          'observer:started',
          'persist:succeeded',
          'observer:succeeded',
        ]);
        expect(calls[0]).not.toHaveBeenCalled();
        expect(calls[1]).toHaveBeenCalledWith(
          expect.objectContaining({
            idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        );
      }
    } finally {
      open.mockRestore();
    }
  },
);
