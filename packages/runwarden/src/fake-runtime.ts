import type {
  AgentRuntime,
  InvocationResult,
  RuntimeInvocationInput,
} from './contracts/runtime.js';
import { emptyInvocationUsage } from './runtime/usage.js';

export type FakeAgentRuntimeResultFactory = (
  input: RuntimeInvocationInput,
  invocationIndex: number,
) => InvocationResult;

export class FakeAgentRuntime implements AgentRuntime {
  private readonly invocations: RuntimeInvocationInput[] = [];

  constructor(
    private readonly result?: InvocationResult | FakeAgentRuntimeResultFactory,
  ) {}

  getInvocationHistory(): readonly RuntimeInvocationInput[] {
    return [...this.invocations];
  }

  async invoke(input: RuntimeInvocationInput): Promise<InvocationResult> {
    const invocationIndex = this.invocations.push(input);
    if (typeof this.result === 'function') {
      return this.result(input, invocationIndex);
    }
    if (this.result) return this.result;
    const text = `Fake runtime response to: ${input.prompt}`;
    return {
      invocationId: input.invocationId,
      runId: input.runId,
      text,
      messages: [
        { role: 'user', content: input.prompt },
        { role: 'assistant', content: text },
      ],
      usage: emptyInvocationUsage(),
      provider: 'fake',
      model: 'fake-agent-runtime',
    };
  }
}
