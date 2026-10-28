import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { RUN_ID_HEADER } from '../brand';
import { AgentRuntimeError } from '../contracts/errors';
import type {
  PolicyDecision,
  RuntimePolicies,
  ToolDefinition,
} from '../contracts/policy';
import type {
  McpToolClient,
  NeutralMessage,
  RuntimeInvocationInput,
  RuntimeMetrics,
} from '../contracts/runtime';
import { AiSdkNativeRuntime } from './ai-sdk-runtime';
import { openAiCompatible } from './model';

const invocation: RuntimeInvocationInput = {
  scope: 'scope-a',
  prompt: 'Current user message',
  conversationId: 'opaque-conversation',
  invocationId: 'inv-1',
  runId: '00000000-0000-4000-8000-000000000001',
};

const historyMessages: NeutralMessage[] = [
  { role: 'user', content: 'Earlier user message' },
  { role: 'assistant', content: 'Prior assistant reply' },
];

const directoryTools = {
  get: 'directory__get_record',
  search: 'directory__search_records',
} as const;

const scheduledTaskTools = { list: 'tasks__list_scheduled' } as const;

const directoryGetTool: ToolDefinition = {
  name: directoryTools.get,
  description: 'Retrieves a directory record by id.',
  inputSchema: z.object({
    recordId: z.number().int().positive(),
  }),
};

const directorySearchTool: ToolDefinition = {
  name: directoryTools.search,
  description: 'Searches directory records.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().email().max(320).optional(),
    externalRef: z.string().trim().min(1).max(200).optional(),
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Expected YYYY-MM-DD date' })
      .optional(),
    limit: z.number().int().positive().max(20).optional(),
  }),
};

const listScheduledTasksInputSchema = z
  .object({
    status: z.enum(['active', 'paused', 'cancelled', 'completed']).optional(),
    query_mode: z.enum(['upcoming', 'next', 'today', 'tomorrow']).optional(),
    time_of_day: z.enum(['morning', 'afternoon', 'evening']).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.time_of_day &&
      value.query_mode !== 'today' &&
      value.query_mode !== 'tomorrow'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['time_of_day'],
        message: 'time_of_day requires query_mode today or tomorrow',
      });
    }
    if (value.query_mode && value.status && value.status !== 'active') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'query_mode always resolves active tasks',
      });
    }
  });

function scheduledListCorrection(error: z.ZodError): string {
  const issues = error.issues.map((issue) => issue.message);
  const corrections = [
    issues.includes('time_of_day requires query_mode today or tomorrow')
      ? 'time_of_day may only be used with query_mode today or tomorrow.'
      : undefined,
    issues.includes('query_mode always resolves active tasks')
      ? 'query_mode may only be combined with active status or omitted status.'
      : undefined,
  ].filter((message): message is string => Boolean(message));
  return corrections.length
    ? `The task list arguments are invalid. ${corrections.join(' ')} Return one corrected tool call.`
    : 'The task list arguments are invalid. Check the allowed fields and values, then return one corrected tool call.';
}

const scheduledListTool: ToolDefinition = {
  name: scheduledTaskTools.list,
  description: 'Lists scheduled tasks.',
  inputSchema: listScheduledTasksInputSchema,
  validateInput: (candidate) => {
    const validation = listScheduledTasksInputSchema.safeParse(candidate);
    return validation.success
      ? { ok: true }
      : { ok: false, correction: scheduledListCorrection(validation.error) };
  },
};

const allTools = [directoryGetTool, directorySearchTool, scheduledListTool];

const usage = {
  cachedInputTokens: undefined,
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 10,
    text: 10,
    reasoning: undefined,
  },
};

function toolCall(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> | string,
) {
  return {
    type: 'tool-call' as const,
    toolCallType: 'function' as const,
    toolCallId,
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
  };
}

function toolStep(...calls: ReturnType<typeof toolCall>[]) {
  return {
    content: calls,
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage,
    warnings: [],
  };
}

function textStep(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  };
}

function runtime(
  responses: Array<ReturnType<typeof toolStep> | ReturnType<typeof textStep>>,
  options: {
    maxToolCallsPerInvocation?: number;
    maxInvocationMs?: number;
    now?: () => number;
    onMetrics?: (metrics: RuntimeMetrics) => void;
    policies?: RuntimePolicies;
    onPolicyDecision?: (decision: PolicyDecision) => void;
  } = {},
) {
  const model = new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: responses,
  });
  const callTool = vi.fn().mockResolvedValue('[{"type":"text","text":"ok"}]');
  const close = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn().mockResolvedValue({ callTool, close });
  const loadSystemPrompt = vi
    .fn()
    .mockResolvedValue('You are a careful assistant.');
  const loadHistory = vi.fn().mockResolvedValue(historyMessages);
  const instance = new AiSdkNativeRuntime({
    loadSystemPrompt,
    loadHistory,
    model,
    tools: allTools,
    mcpClient: { open } as McpToolClient,
    now: options.now,
    onMetrics: options.onMetrics,
    onPolicyDecision: options.onPolicyDecision,
    policies: {
      ...options.policies,
      ...(options.maxToolCallsPerInvocation !== undefined
        ? { maxToolCallsPerInvocation: options.maxToolCallsPerInvocation }
        : {}),
      ...(options.maxInvocationMs !== undefined
        ? { maxDurationMs: options.maxInvocationMs }
        : {}),
    },
  });

  return {
    instance,
    model,
    callTool,
    close,
    open,
    loadSystemPrompt,
    loadHistory,
  };
}

describe('AiSdkNativeRuntime', () => {
  it('reserves the total budget before parallel calls can execute', async () => {
    const onPolicyDecision = vi.fn();
    const subject = runtime(
      [
        toolStep(
          toolCall('first', directoryTools.get, { recordId: 1 }),
          toolCall('excess', directoryTools.get, { recordId: 2 }),
        ),
        textStep('must not be requested'),
      ],
      {
        policies: {
          exactlyOneToolCallPerStep: false,
          maxToolCallsPerInvocation: 1,
        },
        onPolicyDecision,
      },
    );
    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      message: 'Tool-call budget exceeded',
    });
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: { recordId: 1 } }),
    );
    expect(subject.model.doGenerateCalls).toHaveLength(1);
    expect(subject.close).toHaveBeenCalledOnce();
    expect(onPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'max_tool_calls', decision: 'deny' }),
    );
  });

  it('shares one pending MCP session across parallel calls and reports executed metrics', async () => {
    const onMetrics = vi.fn();
    const subject = runtime(
      [
        toolStep(
          toolCall('first', directoryTools.get, { recordId: 1 }),
          toolCall('second', directoryTools.get, { recordId: 2 }),
        ),
        textStep('Done'),
      ],
      {
        policies: {
          exactlyOneToolCallPerStep: false,
          maxToolCallsPerInvocation: 2,
        },
        onMetrics,
      },
    );
    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.close).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledTimes(2);
    expect(onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallCount: 2 }),
    );
  });

  it.each(['multi-call', 'invalid-input'])(
    'issues no %s correction with a zero budget',
    async (kind) => {
      const onPolicyDecision = vi.fn();
      const subject = runtime(
        [
          kind === 'multi-call'
            ? toolStep(
                toolCall('one', directoryTools.get, { recordId: 1 }),
                toolCall('two', directoryTools.get, { recordId: 2 }),
              )
            : toolStep(
                toolCall('invalid', scheduledTaskTools.list, {
                  query_mode: 'upcoming',
                  time_of_day: 'morning',
                }),
              ),
          toolStep(toolCall('corrected', directoryTools.get, { recordId: 3 })),
          textStep('must not be requested'),
        ],
        { policies: { correctionBudget: 0 }, onPolicyDecision },
      );
      await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
        kind: 'failure',
      });
      expect(subject.model.doGenerateCalls).toHaveLength(1);
      expect(subject.open).not.toHaveBeenCalled();
      expect(
        onPolicyDecision.mock.calls.map(([decision]) => decision.decision),
      ).not.toContain('correction_issued');
      expect(onPolicyDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          rule: 'correction_budget',
          decision: 'deny',
        }),
      );
    },
  );

  it('keeps concurrent invocation audit identities separate', async () => {
    const onPolicyDecision = vi.fn();
    const invalid = toolStep(toolCall('invalid', directoryTools.get, {}));
    const subject = runtime([invalid, invalid], { onPolicyDecision });
    const inputs = [
      invocation,
      {
        ...invocation,
        scope: 'scope-b',
        invocationId: 'inv-2',
        runId: 'run-2',
      },
    ];
    const results = await Promise.allSettled(
      inputs.map((input) => subject.instance.invoke(input)),
    );
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(onPolicyDecision).toHaveBeenCalledTimes(2);
    for (const input of inputs) {
      expect(onPolicyDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: input.scope,
          invocationId: input.invocationId,
          runId: input.runId,
        }),
      );
    }
  });

  it('audits invalid calls even within a denied multi-call step', async () => {
    const onPolicyDecision = vi.fn();
    const subject = runtime(
      [
        toolStep(
          toolCall('valid', directoryTools.get, { recordId: 1 }),
          toolCall('invalid', directoryTools.get, {}),
        ),
        toolStep(toolCall('corrected', directoryTools.get, { recordId: 2 })),
        textStep('Done'),
      ],
      { onPolicyDecision },
    );
    await subject.instance.invoke(invocation);
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(onPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'input_validation',
        decision: 'deny',
        toolName: directoryTools.get,
      }),
    );
  });

  it.each([
    [
      'invalid input',
      [toolStep(toolCall('bad', directoryTools.get, {}))],
      'input_validation',
    ],
    [
      'repeated invalid input',
      [
        toolStep(
          toolCall('bad-1', scheduledTaskTools.list, {
            time_of_day: 'morning',
          }),
        ),
        toolStep(
          toolCall('bad-2', scheduledTaskTools.list, {
            time_of_day: 'evening',
          }),
        ),
      ],
      'correction_budget',
    ],
    [
      'wrong correction tool',
      [
        toolStep(
          toolCall('bad', scheduledTaskTools.list, { time_of_day: 'morning' }),
        ),
        toolStep(toolCall('wrong', directoryTools.get, { recordId: 1 })),
      ],
      'input_validation',
    ],
    [
      'missing correction',
      [
        toolStep(
          toolCall('one', directoryTools.get, { recordId: 1 }),
          toolCall('two', directoryTools.get, { recordId: 2 }),
        ),
        textStep('not corrected'),
      ],
      'correction_budget',
    ],
    [
      'repeated multi-call',
      [
        toolStep(
          toolCall('one', directoryTools.get, { recordId: 1 }),
          toolCall('two', directoryTools.get, { recordId: 2 }),
        ),
        toolStep(
          toolCall('three', directoryTools.get, { recordId: 3 }),
          toolCall('four', directoryTools.get, { recordId: 4 }),
        ),
      ],
      'correction_budget',
    ],
  ] as const)(
    'audits terminal %s with invocation identity',
    async (_name, responses, rule) => {
      const onPolicyDecision = vi.fn();
      const subject = runtime([...responses], { onPolicyDecision });
      await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
        kind: 'failure',
      });
      expect(subject.open).not.toHaveBeenCalled();
      expect(onPolicyDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({ rule, decision: 'deny' }),
      );
      for (const [decision] of onPolicyDecision.mock.calls) {
        expect(decision).toMatchObject({
          scope: invocation.scope,
          runId: invocation.runId,
          invocationId: invocation.invocationId,
        });
      }
    },
  );

  it('audits each multi-call denial and its correction', async () => {
    const onPolicyDecision = vi.fn();
    const subject = runtime(
      [
        toolStep(
          toolCall('one', directoryTools.get, { recordId: 1 }),
          toolCall('two', directoryTools.get, { recordId: 2 }),
        ),
        toolStep(toolCall('corrected', directoryTools.get, { recordId: 3 })),
        textStep('Done'),
      ],
      { onPolicyDecision },
    );
    await subject.instance.invoke(invocation);
    expect(
      onPolicyDecision.mock.calls.map(([decision]) => [
        decision.rule,
        decision.decision,
      ]),
    ).toEqual([
      ['exactly_one', 'deny'],
      ['exactly_one', 'deny'],
      ['exactly_one', 'correction_issued'],
    ]);
  });

  it.each<[RuntimePolicies, string, string]>([
    [{ toolAllowlist: [] }, 'allowlist', 'deny'],
    [
      { requireApproval: [directoryTools.get] },
      'require_approval',
      'approval_requested',
    ],
  ])(
    'audits configured interception without executing MCP',
    async (policies, rule, decision) => {
      const onPolicyDecision = vi.fn();
      const subject = runtime(
        [
          toolStep(toolCall('blocked', directoryTools.get, { recordId: 1 })),
          textStep('Denied'),
        ],
        {
          policies,
          onPolicyDecision,
        },
      );
      if (rule === 'require_approval') {
        await expect(subject.instance.invoke(invocation)).rejects.toMatchObject(
          { diagnostics: { code: 'approval_required' } },
        );
      } else {
        await expect(
          subject.instance.invoke(invocation),
        ).resolves.toMatchObject({ text: 'Denied' });
      }
      expect(subject.open).not.toHaveBeenCalled();
      expect(onPolicyDecision).toHaveBeenCalledWith(
        expect.objectContaining({ rule, decision }),
      );
    },
  );

  it('reuses the AI SDK loop for one tool, one MCP session, and final text', async () => {
    const subject = runtime([
      toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
      textStep('Record found'),
    ]);

    await expect(subject.instance.invoke(invocation)).resolves.toEqual({
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      text: 'Record found',
      provider: 'mock-provider',
      model: 'mock-model',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(2);
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.open).toHaveBeenCalledWith({
      runId: invocation.runId,
      timeoutMs: expect.any(Number),
    });
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledWith({
      name: directoryTools.get,
      arguments: { recordId: 7 },
      timeoutMs: expect.any(Number),
    });
    expect(subject.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(subject.model.doGenerateCalls[1]?.prompt)).toContain(
      'ok',
    );
  });

  it('denies a multi-call step before MCP and lets the SDK request one corrected tool', async () => {
    const subject = runtime([
      toolStep(
        toolCall('rejected-1', directoryTools.get, { recordId: 1 }),
        toolCall('rejected-2', directoryTools.get, { recordId: 2 }),
      ),
      toolStep(toolCall('corrected', directoryTools.get, { recordId: 3 })),
      textStep('Done'),
    ]);

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(3);
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: directoryTools.get,
        arguments: { recordId: 3 },
      }),
    );
    expect(JSON.stringify(subject.model.doGenerateCalls[1]?.prompt)).toContain(
      'execution-denied',
    );
    expect(JSON.stringify(subject.model.doGenerateCalls[1]?.prompt)).toContain(
      'exactly one tool call',
    );
  });

  it('gives a later invalid scheduled-list its own correction after a multi-call correction', async () => {
    const subject = runtime([
      toolStep(
        toolCall('rejected-1', directoryTools.get, { recordId: 1 }),
        toolCall('rejected-2', directoryTools.get, { recordId: 2 }),
      ),
      toolStep(toolCall('corrected', directoryTools.get, { recordId: 3 })),
      toolStep(
        toolCall('invalid-list', scheduledTaskTools.list, {
          query_mode: 'upcoming',
          time_of_day: 'morning',
        }),
      ),
      toolStep(
        toolCall('corrected-list', scheduledTaskTools.list, {
          query_mode: 'upcoming',
        }),
      ),
      textStep('Done'),
    ]);

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(5);
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledTimes(2);
    expect(
      subject.callTool.mock.calls.map(([call]) => [call.name, call.arguments]),
    ).toEqual([
      [directoryTools.get, { recordId: 3 }],
      [scheduledTaskTools.list, { query_mode: 'upcoming' }],
    ]);
    expect(JSON.stringify(subject.model.doGenerateCalls[3]?.prompt)).toContain(
      'time_of_day may only be used with query_mode today or tomorrow',
    );
  });

  it('gives a later multi-call its own correction after a scheduled-list correction', async () => {
    const subject = runtime([
      toolStep(
        toolCall('invalid-list', scheduledTaskTools.list, {
          query_mode: 'upcoming',
          time_of_day: 'morning',
        }),
      ),
      toolStep(
        toolCall('corrected-list', scheduledTaskTools.list, {
          query_mode: 'upcoming',
        }),
      ),
      toolStep(
        toolCall('rejected-1', directoryTools.get, { recordId: 1 }),
        toolCall('rejected-2', directoryTools.get, { recordId: 2 }),
      ),
      toolStep(toolCall('corrected', directoryTools.get, { recordId: 3 })),
      textStep('Done'),
    ]);

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(5);
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledTimes(2);
    expect(
      subject.callTool.mock.calls.map(([call]) => [call.name, call.arguments]),
    ).toEqual([
      [scheduledTaskTools.list, { query_mode: 'upcoming' }],
      [directoryTools.get, { recordId: 3 }],
    ]);
    expect(JSON.stringify(subject.model.doGenerateCalls[3]?.prompt)).toContain(
      'exactly one tool call',
    );
  });

  it('does not chain a second correction when a multi-call correction is invalid scheduled-list input', async () => {
    const subject = runtime([
      toolStep(
        toolCall('rejected-1', directoryTools.get, { recordId: 1 }),
        toolCall('rejected-2', directoryTools.get, { recordId: 2 }),
      ),
      toolStep(
        toolCall('invalid-list', scheduledTaskTools.list, {
          query_mode: 'upcoming',
          time_of_day: 'morning',
        }),
      ),
      textStep('must not be requested'),
    ]);

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
      message: 'Provider returned invalid tool input',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(2);
    expect(subject.open).not.toHaveBeenCalled();
    expect(subject.callTool).not.toHaveBeenCalled();
  });

  it('uses canonical scheduled-list validation before MCP and corrects once', async () => {
    const subject = runtime([
      toolStep(
        toolCall('invalid-list', scheduledTaskTools.list, {
          query_mode: 'upcoming',
          time_of_day: 'morning',
        }),
      ),
      toolStep(
        toolCall('corrected-list', scheduledTaskTools.list, {
          query_mode: 'upcoming',
        }),
      ),
      textStep('Listed scheduled tasks.'),
    ]);

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Listed scheduled tasks.',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(3);
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: scheduledTaskTools.list,
        arguments: { query_mode: 'upcoming' },
      }),
    );
    expect(JSON.stringify(subject.model.doGenerateCalls[1]?.prompt)).toContain(
      'time_of_day may only be used with query_mode today or tomorrow',
    );
  });

  it('keeps ordinary invalid tool input terminal without opening MCP', async () => {
    const subject = runtime([
      toolStep(toolCall('invalid', directoryTools.get, {})),
      textStep('must not be requested'),
    ]);

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
      message: 'Provider returned invalid tool input',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(1);
    expect(subject.open).not.toHaveBeenCalled();
  });

  it('normalizes blank optional strings through the SDK input schema validator', async () => {
    const subject = runtime([
      toolStep(
        toolCall('search', directoryTools.search, {
          query: '佐藤洋子',
          phone: '',
          externalRef: '   ',
        }),
      ),
      textStep('Found'),
    ]);

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Found',
    });
    expect(subject.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: directoryTools.search,
        arguments: { query: '佐藤洋子' },
      }),
    );
  });

  it('allows final text at the tool budget and blocks an excess tool before MCP', async () => {
    const subject = runtime(
      [
        toolStep(toolCall('first', directoryTools.get, { recordId: 1 })),
        toolStep(toolCall('excess', directoryTools.get, { recordId: 2 })),
        textStep('must not be requested'),
      ],
      { maxToolCallsPerInvocation: 1 },
    );

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
      message: 'Tool-call budget exceeded',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(2);
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.close).toHaveBeenCalledOnce();
  });

  it('stops after a hard MCP timeout instead of giving the model another turn', async () => {
    const subject = runtime([
      toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
      textStep('must not be requested'),
    ]);
    subject.callTool.mockRejectedValueOnce(
      new AgentRuntimeError('timeout', 'MCP tool call timed out'),
    );

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'timeout',
      message: 'MCP tool call timed out',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(1);
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.close).toHaveBeenCalledOnce();
  });

  it('fails when a correction turn returns text instead of a tool call', async () => {
    const subject = runtime([
      toolStep(
        toolCall('rejected-1', directoryTools.get, { recordId: 1 }),
        toolCall('rejected-2', directoryTools.get, { recordId: 2 }),
      ),
      textStep('I can answer without tools.'),
    ]);

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
      message: 'Provider did not return a corrected tool call',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(2);
    expect(subject.open).not.toHaveBeenCalled();
  });

  it('emits metrics that stay internally consistent with the total duration', async () => {
    const onMetrics = vi.fn();
    const subject = runtime(
      [
        toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
        textStep('Done'),
      ],
      { onMetrics },
    );

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });

    expect(onMetrics).toHaveBeenCalledTimes(1);
    const metrics = onMetrics.mock.calls[0]![0];
    expect(metrics).toEqual({
      runId: invocation.runId,
      contextLoadMs: expect.any(Number),
      historyLoadMs: expect.any(Number),
      providerCallCount: 2,
      toolCallCount: 1,
      totalProviderMs: expect.any(Number),
      totalToolMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    // Shared-clock measurements cannot exceed their enclosing wall time.
    expect(metrics.totalProviderMs).toBeGreaterThanOrEqual(0);
    expect(metrics.totalToolMs).toBeGreaterThanOrEqual(0);
    expect(metrics.totalMs).toBeGreaterThanOrEqual(
      metrics.totalProviderMs + metrics.totalToolMs,
    );
  });

  it('blocks an OpenAI-compatible provider multi-call violation before MCP', async () => {
    const providerResponse = (
      message: Record<string, unknown>,
      finishReason: 'tool_calls' | 'stop',
    ) =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', ...message },
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        providerResponse(
          {
            content: null,
            tool_calls: [
              {
                id: 'rejected-1',
                type: 'function',
                function: {
                  name: directoryTools.get,
                  arguments: '{"recordId":1}',
                },
              },
              {
                id: 'rejected-2',
                type: 'function',
                function: {
                  name: directoryTools.get,
                  arguments: '{"recordId":2}',
                },
              },
            ],
          },
          'tool_calls',
        ),
      )
      .mockResolvedValueOnce(
        providerResponse(
          {
            content: null,
            tool_calls: [
              {
                id: 'corrected',
                type: 'function',
                function: {
                  name: directoryTools.get,
                  arguments: '{"recordId":3}',
                },
              },
            ],
          },
          'tool_calls',
        ),
      )
      .mockResolvedValueOnce(providerResponse({ content: 'Done' }, 'stop'));

    const model = openAiCompatible(
      {
        baseUrl: 'https://provider.example/v1/',
        apiKey: 'provider-secret',
        model: 'test-model',
      },
      fetchImpl,
    );
    const callTool = vi.fn().mockResolvedValue('[{"type":"text","text":"ok"}]');
    const close = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn().mockResolvedValue({ callTool, close });
    const subject = new AiSdkNativeRuntime({
      loadSystemPrompt: vi
        .fn()
        .mockResolvedValue('You are a careful assistant.'),
      loadHistory: vi.fn().mockResolvedValue(historyMessages),
      model,
      tools: allTools,
      mcpClient: { open } as McpToolClient,
    });

    await expect(subject.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: directoryTools.get,
        arguments: { recordId: 3 },
      }),
    );
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0]!;
    expect(String(firstUrl)).toBe(
      'https://provider.example/v1/chat/completions',
    );
    const firstRequest = JSON.parse(String(firstInit?.body));
    expect(firstRequest.parallel_tool_calls).toBe(false);
    expect(firstRequest.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: directoryTools.get }),
        }),
      ]),
    );
    // The run id authorizes the MCP session; it must never reach the provider.
    expect(JSON.stringify(firstInit?.headers)).not.toContain(RUN_ID_HEADER);
    expect(JSON.stringify(fetchImpl.mock.calls[1]![1]?.body)).toContain(
      'exactly one tool call',
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves the per-provider-call timeout in the OpenAI-compatible transport', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('missing abort signal'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const model = openAiCompatible(
      {
        baseUrl: 'https://provider.example/v1/',
        apiKey: 'provider-secret',
        model: 'test-model',
        timeoutMs: 5,
      },
      fetchImpl,
    );
    const subject = new AiSdkNativeRuntime({
      loadSystemPrompt: vi
        .fn()
        .mockResolvedValue('You are a careful assistant.'),
      loadHistory: vi.fn().mockResolvedValue(historyMessages),
      model,
      tools: allTools,
      mcpClient: { open: vi.fn() } as unknown as McpToolClient,
      policies: { maxDurationMs: 5_000 },
    });

    await expect(subject.invoke(invocation)).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reuses one MCP session across sequential tools', async () => {
    const subject = runtime([
      toolStep(toolCall('first', directoryTools.get, { recordId: 1 })),
      toolStep(toolCall('second', directoryTools.get, { recordId: 2 })),
      textStep('Done'),
    ]);

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(subject.model.doGenerateCalls).toHaveLength(3);
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledTimes(2);
    expect(subject.callTool.mock.calls.map(([call]) => call.arguments)).toEqual(
      [{ recordId: 1 }, { recordId: 2 }],
    );
    expect(subject.close).toHaveBeenCalledOnce();
  });

  it('terminates a repeated multi-call after one correction turn', async () => {
    const subject = runtime([
      toolStep(
        toolCall('rejected-1', directoryTools.get, { recordId: 1 }),
        toolCall('rejected-2', directoryTools.get, { recordId: 2 }),
      ),
      toolStep(
        toolCall('rejected-3', directoryTools.get, { recordId: 3 }),
        toolCall('rejected-4', directoryTools.get, { recordId: 4 }),
      ),
    ]);

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
      message: 'Provider returned multiple tool calls',
    });
    expect(subject.model.doGenerateCalls).toHaveLength(2);
    expect(subject.open).not.toHaveBeenCalled();
    expect(subject.callTool).not.toHaveBeenCalled();
  });

  it('terminates a still-invalid scheduled-list correction without a second correction', async () => {
    const subject = runtime([
      toolStep(
        toolCall('invalid-1', scheduledTaskTools.list, {
          query_mode: 'upcoming',
          time_of_day: 'morning',
        }),
      ),
      toolStep(
        toolCall('invalid-2', scheduledTaskTools.list, {
          query_mode: 'next',
          time_of_day: 'evening',
        }),
      ),
    ]);

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
    });
    expect(subject.model.doGenerateCalls).toHaveLength(2);
    expect(subject.open).not.toHaveBeenCalled();
  });

  it('lets a correctable MCP application result drive the next model step', async () => {
    const subject = runtime([
      toolStep(toolCall('first', directoryTools.get, { recordId: 7 })),
      toolStep(toolCall('second', directoryTools.get, { recordId: 8 })),
      textStep('Done'),
    ]);
    subject.callTool
      .mockResolvedValueOnce(
        '[{"type":"text","text":"scheduled_time_must_be_future"}]',
      )
      .mockResolvedValueOnce('[{"type":"text","text":"ok"}]');

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(subject.model.doGenerateCalls).toHaveLength(3);
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.callTool).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(subject.model.doGenerateCalls[1]?.prompt)).toContain(
      'scheduled_time_must_be_future',
    );
  });

  it('stops after a hard MCP failure instead of giving the model another turn', async () => {
    const subject = runtime([
      toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
      textStep('must not be requested'),
    ]);
    subject.callTool.mockRejectedValueOnce(
      new AgentRuntimeError('failure', 'MCP tool call failed'),
    );

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
      message: 'MCP tool call failed',
    });
    expect(subject.model.doGenerateCalls).toHaveLength(1);
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.close).toHaveBeenCalledOnce();
  });

  it('stops after an MCP connection failure instead of giving the model another turn', async () => {
    const subject = runtime([
      toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
      textStep('must not be requested'),
    ]);
    subject.open.mockRejectedValueOnce(
      new AgentRuntimeError('failure', 'MCP connection failed'),
    );

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
      message: 'MCP connection failed',
    });

    expect(subject.model.doGenerateCalls).toHaveLength(1);
    expect(subject.open).toHaveBeenCalledOnce();
    expect(subject.callTool).not.toHaveBeenCalled();
  });

  it('allows final text exactly at the tool budget', async () => {
    const subject = runtime(
      [
        toolStep(toolCall('first', directoryTools.get, { recordId: 1 })),
        toolStep(toolCall('second', directoryTools.get, { recordId: 2 })),
        textStep('Done'),
      ],
      { maxToolCallsPerInvocation: 2 },
    );

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(subject.callTool).toHaveBeenCalledTimes(2);
    expect(subject.model.doGenerateCalls).toHaveLength(3);
  });

  it('stops before provider work when the invocation deadline is exhausted', async () => {
    let clock = 0;
    const subject = runtime([textStep('must not be requested')], {
      maxInvocationMs: 5,
      now: () => clock,
    });
    subject.loadHistory.mockImplementationOnce(async () => {
      clock = 5;
      return historyMessages;
    });

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(subject.model.doGenerateCalls).toHaveLength(0);
    expect(subject.open).not.toHaveBeenCalled();
  });

  it('fails closed before MCP for a proposal the SDK marks invalid', async () => {
    const subject = runtime([
      toolStep(
        toolCall('wrong-type', directoryTools.search, {
          query: '佐藤洋子',
          limit: '10',
        }),
      ),
    ]);

    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      kind: 'failure',
    });
    expect(subject.open).not.toHaveBeenCalled();
    expect(subject.callTool).not.toHaveBeenCalled();
  });
});
