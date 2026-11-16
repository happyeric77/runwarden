import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { RUN_ID_HEADER } from '../brand.js';
import { AgentRuntimeError } from '../contracts/errors.js';
import type {
  BudgetWarning,
  PolicyDecision,
  RuntimePolicies,
  ToolDefinition,
} from '../contracts/policy.js';
import type {
  McpToolClient,
  NeutralMessage,
  RuntimeInvocationInput,
  RuntimeMetrics,
  ToolCallAuditEvent,
  ToolCallAuditSink,
  UsagePricingOptions,
} from '../contracts/runtime.js';
import { AiSdkNativeRuntime, modelMessages } from './ai-sdk-runtime.js';
import { deriveToolCallIdempotencyKey } from './canonical-json.js';
import { openAiCompatible } from './model.js';
import { PolicyEngine } from './policy-engine.js';

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

function metered<
  T extends ReturnType<typeof toolStep> | ReturnType<typeof textStep>,
>(step: T, inputTokens: number, outputTokens: number): T {
  return {
    ...step,
    usage: {
      inputTokens: { total: inputTokens, noCache: inputTokens },
      outputTokens: { total: outputTokens, text: outputTokens },
    },
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
    onBudgetWarning?: (warning: BudgetWarning) => void;
    onToolCallAudit?: ToolCallAuditSink;
    toolError?: Error;
    pricing?: UsagePricingOptions;
  } = {},
) {
  const model = new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doGenerate: responses,
  });
  const callTool = vi.fn().mockImplementation(async () => {
    if (options.toolError) throw options.toolError;
    return '[{"type":"text","text":"ok"}]';
  });
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
    onBudgetWarning: options.onBudgetWarning,
    onToolCallAudit: options.onToolCallAudit,
    pricing: options.pricing,
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
  it('continues after text evades correction without repeating executed tools', async () => {
    const subject = runtime(
      [
        toolStep(toolCall('first', directoryTools.get, { recordId: 1 })),
        toolStep(
          toolCall('burst-2', directoryTools.get, { recordId: 2 }),
          toolCall('burst-3', directoryTools.get, { recordId: 3 }),
        ),
        textStep('Done! All three processed.'),
        toolStep(toolCall('second', directoryTools.get, { recordId: 2 })),
        toolStep(toolCall('third', directoryTools.get, { recordId: 3 })),
        textStep('Actually completed.'),
      ],
      { policies: { correctionBudget: 3 } },
    );
    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Actually completed.',
    });
    expect(
      subject.callTool.mock.calls.map(([call]) => call.arguments.recordId),
    ).toEqual([1, 2, 3]);
    expect(JSON.stringify(subject.model.doGenerateCalls[3]?.prompt)).toContain(
      'Done! All three processed.',
    );
  });

  it('fails after bounded text-only corrections with zero executions', async () => {
    const onPolicyDecision = vi.fn();
    const subject = runtime(
      [
        toolStep(
          toolCall('a', directoryTools.get, { recordId: 1 }),
          toolCall('b', directoryTools.get, { recordId: 2 }),
        ),
        textStep('Done!'),
        textStep('Done!'),
        textStep('Done!'),
      ],
      { policies: { correctionBudget: 3 }, onPolicyDecision },
    );
    await expect(subject.instance.invoke(invocation)).rejects.toThrow(
      'Provider did not return a corrected tool call',
    );
    expect(subject.callTool).not.toHaveBeenCalled();
    expect(subject.model.doGenerateCalls).toHaveLength(4);
    expect(onPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'correction_budget', decision: 'deny' }),
    );
  });
  it.each([
    [
      { nested: { a: 1, b: 2 }, values: [1, 2] },
      { values: [1, 2], nested: { b: 2, a: 1 } },
      true,
    ],
    [[1, 2], [2, 1], false],
    [null, null, true],
    [undefined, undefined, true],
    [null, undefined, false],
  ])('matches canonical approval input %#', (approved, proposed, matches) => {
    const engine = new PolicyEngine(
      { requireApproval: ['gated'] },
      {
        approvedToolCall: { toolName: 'gated', input: approved },
      },
    );
    const verdict = engine.approvalFor({
      toolName: 'gated',
      toolCallId: 'call',
      toolInput: proposed,
      proposalCount: 1,
      scope: '',
    });
    expect(verdict === 'not-applicable').toBe(matches);
    if (!matches)
      expect(engine.terminalError?.diagnostics.code).toBe('approval_required');
  });

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

  it.each([false, true])(
    'evaluates a per-call approval predicate: %s',
    async (required) => {
      const onPolicyDecision = vi.fn();
      const predicate = vi.fn(() => required);
      const subject = runtime(
        [
          toolStep(toolCall('call', directoryTools.get, { recordId: 7 })),
          textStep('Done'),
        ],
        { policies: { requireApproval: predicate }, onPolicyDecision },
      );
      if (required) {
        await expect(subject.instance.invoke(invocation)).rejects.toMatchObject(
          {
            diagnostics: { code: 'approval_required' },
          },
        );
        expect(subject.callTool).not.toHaveBeenCalled();
        expect(onPolicyDecision).toHaveBeenCalledWith(
          expect.objectContaining({
            rule: 'require_approval',
            decision: 'approval_requested',
          }),
        );
      } else {
        await expect(
          subject.instance.invoke(invocation),
        ).resolves.toMatchObject({ text: 'Done' });
        expect(subject.callTool).toHaveBeenCalledOnce();
        expect(onPolicyDecision).not.toHaveBeenCalledWith(
          expect.objectContaining({ decision: 'approval_requested' }),
        );
      }
      expect(predicate).toHaveBeenCalledWith({
        scope: invocation.scope,
        toolName: directoryTools.get,
        input: { recordId: 7 },
      });
    },
  );

  it('propagates approval predicate errors without executing the tool', async () => {
    const failure = new Error('approval predicate exploded');
    const subject = runtime(
      [toolStep(toolCall('call', directoryTools.get, { recordId: 7 }))],
      {
        policies: {
          requireApproval: () => {
            throw failure;
          },
        },
      },
    );
    await expect(subject.instance.invoke(invocation)).rejects.toBe(failure);
    expect(subject.callTool).not.toHaveBeenCalled();
  });

  it('executes a gated call that matches an approved tool call', async () => {
    const onPolicyDecision = vi.fn();
    const subject = runtime(
      [
        toolStep(toolCall('gated', directoryTools.get, { recordId: 7 })),
        textStep('Done'),
      ],
      {
        policies: { requireApproval: [directoryTools.get] },
        onPolicyDecision,
      },
    );

    await expect(
      subject.instance.invoke({
        ...invocation,
        approvedToolCall: {
          toolName: directoryTools.get,
          input: { recordId: 7 },
        },
      }),
    ).resolves.toMatchObject({ text: 'Done' });
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(onPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'require_approval',
        decision: 'allow',
        detail: { viaApproval: true },
      }),
    );
  });

  it('does not let an approval bypass the shared tool budget', async () => {
    const onPolicyDecision = vi.fn();
    const subject = runtime(
      [
        toolStep(
          toolCall('ordinary', directoryTools.search, { query: 'roadmap' }),
        ),
        toolStep(toolCall('approved', directoryTools.get, { recordId: 7 })),
        textStep('must not be requested'),
      ],
      {
        maxToolCallsPerInvocation: 1,
        policies: { requireApproval: [directoryTools.get] },
        onPolicyDecision,
      },
    );
    await expect(
      subject.instance.invoke({
        ...invocation,
        approvedToolCall: {
          toolName: directoryTools.get,
          input: { recordId: 7 },
        },
      }),
    ).rejects.toMatchObject({ message: 'Tool-call budget exceeded' });
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.callTool.mock.calls[0]![0].name).toBe(directoryTools.search);
    expect(onPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'max_tool_calls',
        decision: 'deny',
        toolName: directoryTools.get,
      }),
    );
    expect(onPolicyDecision).not.toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'require_approval',
        decision: 'allow',
      }),
    );
  });

  it('consumes an exact approval only once', async () => {
    const subject = runtime(
      [
        toolStep(toolCall('first', directoryTools.get, { recordId: 7 })),
        toolStep(toolCall('second', directoryTools.get, { recordId: 7 })),
      ],
      { policies: { requireApproval: [directoryTools.get] } },
    );
    await expect(
      subject.instance.invoke({
        ...invocation,
        approvedToolCall: {
          toolName: directoryTools.get,
          input: { recordId: 7 },
        },
      }),
    ).rejects.toMatchObject({ diagnostics: { code: 'approval_required' } });
    expect(subject.callTool).toHaveBeenCalledOnce();
  });

  it('parks a gated call whose input differs from the approved call', async () => {
    const subject = runtime(
      [toolStep(toolCall('gated', directoryTools.get, { recordId: 7 }))],
      { policies: { requireApproval: [directoryTools.get] } },
    );

    await expect(
      subject.instance.invoke({
        ...invocation,
        approvedToolCall: {
          toolName: directoryTools.get,
          input: { recordId: 8 },
        },
      }),
    ).rejects.toMatchObject({
      diagnostics: {
        code: 'approval_required',
        pendingToolCall: {
          toolName: directoryTools.get,
          input: { recordId: 7 },
        },
      },
    });
    expect(subject.callTool).not.toHaveBeenCalled();
  });

  it('derives idempotency keys that ignore object key order only', () => {
    const a = deriveToolCallIdempotencyKey('inv-1', 'tool', {
      nested: { a: 1, b: 2 },
      values: [1, 2],
    });
    const b = deriveToolCallIdempotencyKey('inv-1', 'tool', {
      values: [1, 2],
      nested: { b: 2, a: 1 },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      deriveToolCallIdempotencyKey('inv-1', 'tool', { values: [2, 1] }),
    ).not.toBe(
      deriveToolCallIdempotencyKey('inv-1', 'tool', { values: [1, 2] }),
    );
    expect(deriveToolCallIdempotencyKey('inv-2', 'tool', { v: 1 })).not.toBe(
      deriveToolCallIdempotencyKey('inv-1', 'tool', { v: 1 }),
    );
  });

  it('emits started and succeeded audit events for an executed call', async () => {
    const events: ToolCallAuditEvent[] = [];
    const subject = runtime(
      [
        toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
        textStep('Done'),
      ],
      { onToolCallAudit: (event) => void events.push(event) },
    );
    await subject.instance.invoke(invocation);
    expect(events.map((event) => event.phase)).toEqual([
      'started',
      'succeeded',
    ]);
    expect(events[0]).toMatchObject({
      scope: invocation.scope,
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      toolName: directoryTools.get,
      toolCallId: 'call-1',
      input: { recordId: 7 },
    });
    expect(events[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(events[1]?.idempotencyKey).toBe(events[0]?.idempotencyKey);
    expect(subject.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: events[0]?.idempotencyKey }),
    );
  });

  it('emits a failed audit event when the MCP call throws', async () => {
    const events: ToolCallAuditEvent[] = [];
    const subject = runtime(
      [toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 }))],
      {
        onToolCallAudit: (event) => void events.push(event),
        toolError: new Error('server exploded'),
      },
    );
    await expect(subject.instance.invoke(invocation)).rejects.toThrow();
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed']);
    expect(events[1]?.errorCode).toBe('tool_call_failed');
  });

  it('keeps retry and approval keys stable while separating parallel dispatches', async () => {
    const events: ToolCallAuditEvent[] = [];
    const responses = [
      toolStep(
        toolCall('same', directoryTools.get, { recordId: 7 }),
        toolCall('same', directoryTools.get, { recordId: 7 }),
      ),
      textStep('Done'),
    ];
    const subject = runtime(responses, {
      policies: { exactlyOneToolCallPerStep: false },
      onToolCallAudit: (event) => void events.push(event),
    });
    await subject.instance.invoke(invocation);
    const rerun = runtime(
      [
        toolStep(toolCall('approved', directoryTools.get, { recordId: 7 })),
        textStep('Done'),
      ],
      {
        policies: { requireApproval: [directoryTools.get] },
        onToolCallAudit: (event) => void events.push(event),
      },
    );
    await rerun.instance.invoke({
      ...invocation,
      runId: 'next-run',
      approvedToolCall: {
        toolName: directoryTools.get,
        input: { recordId: 7 },
      },
    });
    const starts = events.filter((event) => event.phase === 'started');
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((event) => event.idempotencyKey)).size).toBe(1);
    expect(new Set(starts.map((event) => event.dispatchId)).size).toBe(3);
    for (const start of starts)
      expect(
        events
          .filter((event) => event.dispatchId === start.dispatchId)
          .map((event) => event.phase),
      ).toEqual(['started', 'succeeded']);
  });

  it('emits no audit events for a policy-denied call', async () => {
    const events: ToolCallAuditEvent[] = [];
    const subject = runtime(
      [toolStep(toolCall('gated', directoryTools.get, { recordId: 7 }))],
      {
        policies: { requireApproval: [directoryTools.get] },
        onToolCallAudit: (event) => void events.push(event),
      },
    );
    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      diagnostics: { code: 'approval_required' },
    });
    expect(events).toEqual([]);
    expect(subject.callTool).not.toHaveBeenCalled();
  });

  it('does not dispatch when the started audit write fails', async () => {
    const subject = runtime(
      [
        toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
        textStep('Done'),
      ],
      {
        onToolCallAudit: () => {
          throw new Error('audit store down');
        },
      },
    );
    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      diagnostics: { code: 'audit_persistence_failed' },
    });
    expect(subject.callTool).not.toHaveBeenCalled();
  });

  it('prioritizes a failed audit write over the original MCP error', async () => {
    const subject = runtime(
      [
        toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
        textStep('must not be requested'),
      ],
      {
        toolError: new Error('MCP failed'),
        onToolCallAudit: (event) => {
          if (event.phase === 'failed') throw new Error('audit store down');
        },
      },
    );
    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      diagnostics: { code: 'audit_persistence_failed' },
    });
    expect(subject.callTool).toHaveBeenCalledOnce();
    expect(subject.model.doGenerateCalls).toHaveLength(1);
  });

  it('fails the invocation when the succeeded audit write fails', async () => {
    const subject = runtime(
      [
        toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
        textStep('Done'),
      ],
      {
        onToolCallAudit: (event) => {
          if (event.phase === 'succeeded') throw new Error('audit store down');
        },
      },
    );
    await expect(subject.instance.invoke(invocation)).rejects.toMatchObject({
      diagnostics: { code: 'audit_persistence_failed' },
    });
    expect(subject.callTool).toHaveBeenCalledOnce();
  });

  it('reuses the AI SDK loop for one tool, one MCP session, and final text', async () => {
    const subject = runtime([
      toolStep(toolCall('call-1', directoryTools.get, { recordId: 7 })),
      textStep('Record found'),
    ]);

    await expect(subject.instance.invoke(invocation)).resolves.toEqual({
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      text: 'Record found',
      messages: [
        { role: 'user', content: invocation.prompt },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: directoryTools.get,
              input: { recordId: 7 },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: directoryTools.get,
              output: { type: 'text', value: '[{"type":"text","text":"ok"}]' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Record found' }],
        },
      ],
      usage: {
        inputTokens: 6,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costIncomplete: true,
        steps: [
          {
            inputTokens: 3,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            provider: 'mock-provider',
            model: 'mock-model',
            usageKnown: true,
            costKnown: false,
          },
          {
            inputTokens: 3,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            provider: 'mock-provider',
            model: 'mock-model',
            usageKnown: true,
            costKnown: false,
          },
        ],
      },
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
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(subject.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(subject.model.doGenerateCalls[1]?.prompt)).toContain(
      'ok',
    );
  });

  it('meters every step, including tool steps, into the invocation usage', async () => {
    const richUsage = {
      cachedInputTokens: undefined,
      inputTokens: {
        total: 10,
        noCache: 4,
        cacheRead: 3,
        cacheWrite: 3,
      },
      outputTokens: { total: 6, text: 4, reasoning: 2 },
    } as unknown as typeof usage;
    const subject = runtime(
      [
        {
          content: [toolCall('call-1', directoryTools.get, { recordId: 7 })],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
          usage: richUsage,
          warnings: [],
        },
        {
          content: [{ type: 'text' as const, text: 'Record found' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: richUsage,
          warnings: [],
        },
      ],
      {
        pricing: {
          overrides: [
            {
              model: 'mock-model',
              inputPerMillionTokens: 1,
              outputPerMillionTokens: 2,
              cacheReadPerMillionTokens: 0.5,
              cacheWritePerMillionTokens: 0.25,
            },
          ],
        },
      },
    );

    const result = await subject.instance.invoke(invocation);

    expect(result.usage).toMatchObject({
      inputTokens: 8,
      outputTokens: 8,
      cacheReadTokens: 6,
      cacheWriteTokens: 6,
      reasoningTokens: 4,
      costIncomplete: false,
    });
    expect(result.usage.costUsd).toBeCloseTo(0.0000365, 12);
    expect(result.usage.steps).toHaveLength(2);
    for (const step of result.usage.steps) {
      expect(step).toMatchObject({
        inputTokens: 4,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
        provider: 'mock-provider',
        model: 'mock-model',
        usageKnown: true,
        costKnown: true,
      });
      expect(step.costUsd).toBeCloseTo(0.00001825, 12);
    }
  });

  it('warns once at exactly 80 percent without stopping', async () => {
    const decisions: PolicyDecision[] = [];
    const warnings: BudgetWarning[] = [];
    const subject = runtime([metered(textStep('Done'), 8, 0)], {
      policies: { budget: { maxTokens: 10 } },
      onPolicyDecision: (decision) => decisions.push(decision),
      onBudgetWarning: (warning) => warnings.push(warning),
    });

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(warnings).toEqual([
      {
        scope: 'scope-a',
        invocationId: 'inv-1',
        runId: '00000000-0000-4000-8000-000000000001',
        limitKind: 'tokens',
        accumulated: 8,
        limit: 10,
        threshold: 0.8,
        stepNumber: 1,
        completeness: 'complete',
      },
    ]);
    expect(
      decisions.filter((decision) => decision.decision === 'warning'),
    ).toHaveLength(1);
    expect(
      decisions.filter((decision) => decision.decision === 'exceeded'),
    ).toHaveLength(0);
  });

  it('records warning then exceeded when one final step reaches the limit', async () => {
    const decisions: PolicyDecision[] = [];
    const warnings: BudgetWarning[] = [];
    const subject = runtime([metered(textStep('Done'), 10, 0)], {
      policies: { budget: { maxTokens: 10 } },
      onPolicyDecision: (decision) => decisions.push(decision),
      onBudgetWarning: (warning) => warnings.push(warning),
    });

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(warnings).toHaveLength(1);
    expect(decisions.map((decision) => decision.decision)).toEqual([
      'warning',
      'exceeded',
    ]);
    expect(decisions[1]?.detail).toMatchObject({
      event: 'exceeded',
      terminal: 'final_step',
      accumulated: 10,
    });
  });

  it('stops before the next provider call when a tool step reaches the token budget', async () => {
    const decisions: PolicyDecision[] = [];
    const warnings: BudgetWarning[] = [];
    const subject = runtime(
      [
        metered(
          toolStep(toolCall('budget-1', directoryTools.get, { recordId: 7 })),
          11,
          0,
        ),
        metered(textStep('Should not run'), 1, 0),
      ],
      {
        policies: { budget: { maxTokens: 10 } },
        onPolicyDecision: (decision) => decisions.push(decision),
        onBudgetWarning: (warning) => warnings.push(warning),
      },
    );

    const error = await subject.instance
      .invoke(invocation)
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect(error).toMatchObject({
      kind: 'budget',
      message: 'Invocation budget exceeded',
      diagnostics: {
        code: 'budget_exceeded',
        invocationId: 'inv-1',
        runId: '00000000-0000-4000-8000-000000000001',
      },
      usage: { inputTokens: 11, outputTokens: 0 },
    });
    expect(error.diagnostics.limits).toEqual([
      {
        limitKind: 'tokens',
        accumulated: 11,
        limit: 10,
        stepNumber: 1,
        completeness: 'complete',
      },
    ]);
    expect(subject.model.doGenerateCalls).toHaveLength(1);
    expect(subject.callTool).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(decisions.map((decision) => decision.decision)).toEqual([
      'warning',
      'exceeded',
    ]);
  });

  it('reports both token and cost limits in one budget error', async () => {
    const warnings: BudgetWarning[] = [];
    const subject = runtime(
      [
        metered(
          toolStep(toolCall('both-1', directoryTools.get, { recordId: 7 })),
          6,
          5,
        ),
      ],
      {
        policies: {
          budget: { maxTokens: 10, maxCostUsd: 0.000001 },
        },
        pricing: {
          overrides: [
            {
              model: 'mock-model',
              inputPerMillionTokens: 1,
              outputPerMillionTokens: 1,
            },
          ],
        },
        onBudgetWarning: (warning) => warnings.push(warning),
      },
    );

    const error = await subject.instance
      .invoke(invocation)
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect(error.kind).toBe('budget');
    expect(error.diagnostics.limits).toHaveLength(2);
    expect(
      (error.diagnostics.limits as Array<{ limitKind: string }>).map(
        (limit) => limit.limitKind,
      ),
    ).toEqual(['tokens', 'costUsd']);
    expect(warnings.map((warning) => warning.limitKind)).toEqual([
      'tokens',
      'costUsd',
    ]);
  });

  it('logs one warning and one crossing per limit and keeps running', async () => {
    const decisions: PolicyDecision[] = [];
    const warnings: BudgetWarning[] = [];
    const subject = runtime(
      [
        metered(
          toolStep(toolCall('log-1', directoryTools.get, { recordId: 7 })),
          11,
          0,
        ),
        metered(textStep('Done'), 1, 0),
      ],
      {
        policies: { budget: { maxTokens: 10, onExceeded: 'log' } },
        onPolicyDecision: (decision) => decisions.push(decision),
        onBudgetWarning: (warning) => warnings.push(warning),
      },
    );

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(subject.model.doGenerateCalls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(
      decisions.filter((decision) => decision.decision === 'warning'),
    ).toHaveLength(1);
    expect(
      decisions.filter((decision) => decision.decision === 'exceeded'),
    ).toHaveLength(1);
  });

  it('never enforces a cost budget when cost is unknown', async () => {
    const decisions: PolicyDecision[] = [];
    const warnings: BudgetWarning[] = [];
    const subject = runtime(
      [
        metered(
          toolStep(
            toolCall('unknown-cost', directoryTools.get, { recordId: 7 }),
          ),
          1,
          1,
        ),
        metered(textStep('Done'), 1, 1),
      ],
      {
        policies: { budget: { maxCostUsd: 0.000001 } },
        onPolicyDecision: (decision) => decisions.push(decision),
        onBudgetWarning: (warning) => warnings.push(warning),
      },
    );

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(subject.model.doGenerateCalls).toHaveLength(2);
    expect(warnings).toHaveLength(0);
    expect(
      decisions.filter((decision) => decision.decision === 'incomplete'),
    ).toHaveLength(1);
    expect(
      decisions.find((decision) => decision.decision === 'incomplete')?.detail,
    ).toMatchObject({
      limitKind: 'costUsd',
      accumulated: null,
      reason: 'cost_unknown',
    });
  });

  it('records incomplete token usage without treating it as a known zero', async () => {
    const decisions: PolicyDecision[] = [];
    const step = {
      ...textStep('Done'),
      usage: {
        cachedInputTokens: undefined,
        inputTokens: { total: undefined },
        outputTokens: { total: undefined },
      },
    } as unknown as ReturnType<typeof textStep>;
    const subject = runtime([step], {
      policies: { budget: { maxTokens: 100 } },
      onPolicyDecision: (decision) => decisions.push(decision),
    });

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(
      decisions.filter((decision) => decision.decision === 'incomplete'),
    ).toHaveLength(1);
    expect(
      decisions.find((decision) => decision.decision === 'incomplete')?.detail,
    ).toMatchObject({
      limitKind: 'tokens',
      reason: 'usage_incomplete',
      completeness: 'lower_bound',
    });
  });

  it('keeps a final answer and records an exceeded budget on the final text step', async () => {
    const decisions: PolicyDecision[] = [];
    const subject = runtime([metered(textStep('Done'), 12, 0)], {
      policies: { budget: { maxTokens: 10 } },
      onPolicyDecision: (decision) => decisions.push(decision),
    });

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
    expect(
      decisions.find((decision) => decision.decision === 'exceeded')?.detail,
    ).toMatchObject({ terminal: 'final_step' });
  });

  it('does not let a throwing budget warning observer fail the invocation', async () => {
    const subject = runtime([metered(textStep('Done'), 10, 0)], {
      policies: { budget: { maxTokens: 10 } },
      onBudgetWarning: () => {
        throw new Error('observer failed');
      },
    });

    await expect(subject.instance.invoke(invocation)).resolves.toMatchObject({
      text: 'Done',
    });
  });

  it('preserves an existing policy terminal when a budget also crosses', async () => {
    const decisions: PolicyDecision[] = [];
    const subject = runtime(
      [
        metered(
          toolStep(
            toolCall('terminal-1', directoryTools.get, { recordId: 1 }),
            toolCall('terminal-2', directoryTools.get, { recordId: 2 }),
          ),
          11,
          0,
        ),
      ],
      {
        policies: {
          correctionBudget: 0,
          budget: { maxTokens: 10 },
        },
        onPolicyDecision: (decision) => decisions.push(decision),
      },
    );

    const error = await subject.instance
      .invoke(invocation)
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect(error.kind).toBe('failure');
    expect(error.diagnostics.code).not.toBe('budget_exceeded');
    expect(
      decisions.find((decision) => decision.decision === 'exceeded')?.detail,
    ).toMatchObject({
      terminal: error.diagnostics.code,
    });
  });

  it('rejects invalid budget configuration before a provider call', async () => {
    const subject = runtime([textStep('Done')], {
      policies: { budget: { maxTokens: 0 } },
    });

    await expect(subject.instance.invoke(invocation)).rejects.toThrow(
      'budget.maxTokens',
    );
    expect(subject.model.doGenerateCalls).toHaveLength(0);
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

  it('round-trips first invocation tool results into the next invocation history', async () => {
    const listResult =
      '[{"type":"text","text":"1: booking one, 2: booking two, 3: booking three"}]';
    const subject = runtime([
      toolStep(
        toolCall('list-1', scheduledTaskTools.list, {
          query_mode: 'upcoming',
        }),
      ),
      textStep('Listed three bookings.'),
      textStep('Cancelling the second booking now.'),
    ]);
    subject.callTool.mockResolvedValueOnce(listResult);

    const first = await subject.instance.invoke(invocation);
    expect(first.messages).toEqual([
      { role: 'user', content: invocation.prompt },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'list-1',
            toolName: scheduledTaskTools.list,
            input: { query_mode: 'upcoming' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'list-1',
            toolName: scheduledTaskTools.list,
            output: { type: 'text', value: listResult },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Listed three bookings.' }],
      },
    ]);

    subject.loadHistory.mockResolvedValueOnce(first.messages);
    const second = await subject.instance.invoke({
      ...invocation,
      invocationId: 'inv-2',
      prompt: 'Cancel the second one.',
    });

    expect(second.messages).toEqual([
      { role: 'user', content: 'Cancel the second one.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Cancelling the second booking now.' }],
      },
    ]);
    const secondPrompt = JSON.stringify(
      subject.model.doGenerateCalls[2]?.prompt,
    );
    expect(secondPrompt).toContain('2: booking two');
    expect(secondPrompt).toContain('list-1');
  });
});

describe('modelMessages', () => {
  it('maps plain text history exactly as before', () => {
    expect(modelMessages(historyMessages, invocation)).toEqual([
      { role: 'user', content: 'Earlier user message' },
      { role: 'assistant', content: 'Prior assistant reply' },
      { role: 'user', content: 'Current user message' },
    ]);
  });

  it('maps tool-call and tool-result parts of the widened history', () => {
    const toolResult = '[{"type":"text","text":"ok"}]';
    const history: NeutralMessage[] = [
      { role: 'user', content: 'List my tasks.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking them up.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: scheduledTaskTools.list,
            input: { query_mode: 'upcoming' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: scheduledTaskTools.list,
            output: { type: 'text', value: toolResult },
          },
        ],
      },
    ];

    expect(modelMessages(history, invocation)).toEqual([
      { role: 'user', content: 'List my tasks.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking them up.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: scheduledTaskTools.list,
            input: { query_mode: 'upcoming' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: scheduledTaskTools.list,
            output: { type: 'text', value: toolResult },
          },
        ],
      },
      { role: 'user', content: invocation.prompt },
    ]);
  });

  it('applies maxToolResultBytes to replayed tool results', () => {
    const history: NeutralMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: scheduledTaskTools.list,
            output: { type: 'text', value: 'x'.repeat(11) },
          },
        ],
      },
    ];

    expect(() => modelMessages(history, invocation, 10)).toThrow(
      'MCP tool result exceeded limit',
    );
  });

  it('applies maxToolResultBytes to replayed execution-denied reasons', () => {
    const history: NeutralMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: scheduledTaskTools.list,
            output: { type: 'execution-denied', reason: 'x'.repeat(11) },
          },
        ],
      },
    ];

    expect(() => modelMessages(history, invocation, 10)).toThrow(
      'MCP tool result exceeded limit',
    );
  });
});
