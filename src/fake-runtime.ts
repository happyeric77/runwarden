import type {
  AgentRuntime,
  InvocationResult,
  RuntimeInvocationInput,
} from './contracts/runtime';

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
    return (
      this.result ?? {
        invocationId: input.invocationId,
        runId: input.runId,
        text: `Fake runtime response to: ${input.prompt}`,
        provider: 'fake',
        model: 'fake-agent-runtime',
      }
    );
  }
}
