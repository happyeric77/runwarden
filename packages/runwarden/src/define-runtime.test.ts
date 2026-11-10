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

function noteModel() {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const promptText = JSON.stringify(options.prompt);
      const usage = {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      };
      if (promptText.includes('note body')) {
        return {
          content: [{ type: 'text', text: 'Got the note.' }],
          finishReason: { unified: 'stop', raw: 'stop' } as const,
          usage,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-note',
            toolName: 'notes__get',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' } as const,
        usage,
        warnings: [],
      };
    },
  });
}

function recordingMcpClient(openedRunIds: string[]) {
  return {
    async open(input: { runId: string }) {
      openedRunIds.push(input.runId);
      return {
        async callTool() {
          return JSON.stringify([{ type: 'text', text: 'note body' }]);
        },
        async close() {},
      };
    },
  };
}

const noteTools = [
  {
    name: 'notes__get',
    description: 'Get a note',
    inputSchema: z.object({}),
  },
];

it('uses a caller-supplied runId for direct execution', async () => {
  const openedRunIds: string[] = [];
  const runtime = api.defineRuntime({
    model: noteModel(),
    tools: noteTools,
    mcpClient: recordingMcpClient(openedRunIds),
  });
  const result = await runtime.invoke({
    scope: 'scope-a',
    prompt: 'Get a note',
    runId: 'host-run-42',
  });
  expect(result.text).toBe('Got the note.');
  expect(result.runId).toBe('host-run-42');
  expect(openedRunIds).toEqual(['host-run-42']);
});

it('generates a fresh UUID runId per direct invocation by default', async () => {
  const openedRunIds: string[] = [];
  const runtime = api.defineRuntime({
    model: noteModel(),
    tools: noteTools,
    mcpClient: recordingMcpClient(openedRunIds),
  });
  const first = await runtime.invoke({
    scope: 'scope-a',
    prompt: 'Get a note',
  });
  const second = await runtime.invoke({
    scope: 'scope-a',
    prompt: 'Get a note',
  });
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  expect(first.runId).toMatch(uuid);
  expect(second.runId).toMatch(uuid);
  expect(first.runId).not.toBe(second.runId);
  expect(openedRunIds).toEqual([first.runId, second.runId]);
});
