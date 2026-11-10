import { describe, expect, it } from 'vitest';

import { FakeAgentRuntime } from './fake-runtime.js';

describe('FakeAgentRuntime', () => {
  it('records neutral invocations and returns a deterministic result', async () => {
    const runtime = new FakeAgentRuntime();
    const input = {
      scope: 'scope-a',
      prompt: 'Hello',
      conversationId: 'opaque-conversation',
      invocationId: 'inv-1',
      runId: 'run-1',
    };

    await expect(runtime.invoke(input)).resolves.toEqual({
      invocationId: 'inv-1',
      runId: 'run-1',
      text: 'Fake runtime response to: Hello',
      provider: 'fake',
      model: 'fake-agent-runtime',
    });
    expect(runtime.getInvocationHistory()).toEqual([input]);
  });
});
