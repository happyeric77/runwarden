import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  status: 'succeeded',
  resolution: 'text',
  query: vi.fn(),
  approve: vi.fn(),
}));

vi.mock('../../src/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/index')>();
  return {
    ...actual,
    createDb: () => ({ pool: { query: fixture.query }, close: async () => {} }),
    initDb: async () => {},
    runWorker: () => ({ stop: async () => {} }),
    defineRuntime: () => ({
      invoke: async ({ maxAttempts }: { maxAttempts?: number }) => {
        if (!maxAttempts) return { invocationId: '1', text: 'Roadmap' };
        throw new actual.AgentRuntimeError('failure', 'Approval required', {
          code: 'approval_required',
          invocationId: '2',
        });
      },
      listPendingApprovals: async () => [
        {
          id: '2',
          pendingToolCall: {
            toolName: 'billing__refund',
            input: { amountCents: 5000 },
          },
        },
      ],
      approveInvocation: fixture.approve,
      waitForInvocation: async () => {
        if (fixture.resolution === 'park')
          throw new actual.AgentRuntimeError(
            'failure',
            'Changed refund requires approval',
            {
              code: 'approval_required',
              invocationId: '2',
            },
          );
        if (fixture.resolution === 'fail')
          throw new actual.AgentRuntimeError('failure', 'Provider failed', {
            code: 'execution_failed',
            invocationId: '2',
          });
        return { invocationId: '2', text: 'I will not issue a refund.' };
      },
    }),
  };
});
vi.mock('./mcp-server', () => ({
  startQuickstartMcpServer: async () => ({
    url: 'http://localhost',
    close: async () => {},
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(['text', 'park', 'fail', 'allow'])(
  'reports the audited rerun honestly: %s',
  async (resolution) => {
    vi.resetModules();
    vi.stubEnv('MODEL_API_KEY', 'test-only');
    fixture.resolution = resolution;
    fixture.status =
      resolution === 'park'
        ? 'awaiting_approval'
        : resolution === 'fail'
          ? 'failed'
          : 'succeeded';
    fixture.approve.mockReset();
    fixture.query.mockReset().mockImplementation(async (sql: string) => ({
      rows: sql.includes('policy_decisions')
        ? [
            'approval_requested',
            'approved',
            ...(resolution === 'allow' ? ['allow'] : []),
          ].map((decision) => ({
            invocation_id: '2',
            rule: 'require_approval',
            decision,
            tool_name: 'billing__refund',
          }))
        : [
            { id: '1', status: 'succeeded', attempt_count: 1 },
            { id: '2', status: fixture.status, attempt_count: 1 },
          ],
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('./main');
    const output = log.mock.calls.flat().join('\n');
    expect(fixture.approve).toHaveBeenCalledTimes(1);
    expect(fixture.query).toHaveBeenCalledTimes(2);
    expect(fixture.query.mock.calls[0]![1]).toEqual([['1', '2']]);
    expect(output).toContain('[audit]');
    expect(output).not.toContain('rerun that executed the exact approved call');
    if (resolution === 'text')
      expect(output).toContain('did not propose the approved refund');
    if (resolution === 'park') expect(output).toContain('awaiting_approval');
    if (resolution === 'fail') expect(output).toContain('Provider failed');
    if (resolution === 'allow')
      expect(output).toContain('allowed the approved refund');
  },
);
