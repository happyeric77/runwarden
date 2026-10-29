import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  invoke: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/index', async (original) => ({
  ...(await original<typeof import('../../src/index')>()),
  createDb: () => ({ pool: { query: fixture.query }, close: async () => {} }),
  initDb: async () => {},
  defineRuntime: () => ({ invoke: fixture.invoke }),
  runWorker: () => ({ stop: async () => {} }),
}));
vi.mock('./mcp-server', () => ({
  startQuickstartMcpServer: async () => ({
    url: 'http://localhost:43121',
    close: async () => {},
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.resetModules();
});

it.each(['gated', 'text', 'failure'] as const)(
  'audits both invocations and reports only observed evidence: %s',
  async (outcome) => {
    vi.stubEnv('MODEL_API_KEY', 'test-only');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { AgentRuntimeError } = await import('../../src/index');
    fixture.invoke.mockResolvedValueOnce({
      invocationId: '3',
      text: 'Roadmap',
    });
    if (outcome === 'text') {
      fixture.invoke.mockResolvedValueOnce({
        invocationId: '4',
        text: 'I cannot issue a refund.',
      });
    } else {
      fixture.invoke.mockRejectedValueOnce(
        new AgentRuntimeError('failure', 'Refund stopped', {
          invocationId: '4',
          code: outcome === 'gated' ? 'approval_required' : 'execution_failed',
        }),
      );
    }
    fixture.query.mockResolvedValueOnce({
      rows: [
        { id: '3', status: 'succeeded', attempt_count: 1 },
        {
          id: '4',
          status: outcome === 'text' ? 'succeeded' : 'failed',
          attempt_count: 1,
        },
      ],
    });
    fixture.query.mockResolvedValueOnce({
      rows:
        outcome === 'gated'
          ? [
              {
                invocation_id: '4',
                rule: 'require_approval',
                decision: 'approval_requested',
                tool_name: 'billing__refund',
              },
            ]
          : [],
    });

    await import('./main');

    expect(fixture.invoke.mock.calls[1][0].prompt).toContain('5000 cents');
    expect(fixture.invoke.mock.calls[1][0].prompt).toContain(
      'duplicate charge',
    );
    for (const call of fixture.query.mock.calls)
      expect(call[1]).toEqual([['3', '4']]);
    const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(output).toContain('invocation 3: status=succeeded');
    expect(output).toContain('invocation 4: status=');
    expect(output.includes('the gated refund never ran')).toBe(
      outcome === 'gated',
    );
    expect(output).not.toContain('the search executed through MCP');
    if (outcome === 'text') {
      expect(output).toContain('I cannot issue a refund.');
      expect(output).toContain(
        'no gated call was proposed, so nothing was intercepted',
      );
    }
    if (outcome === 'failure')
      expect(output).not.toContain('stopped as designed');
  },
);
