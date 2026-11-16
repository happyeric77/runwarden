import type { McpToolClient } from '../contracts/runtime.js';

export const TEST_STEP_USAGE = {
  inputTokens: { total: 1, noCache: 1 },
  outputTokens: { total: 1, text: 1 },
};

// The mock model's result type is not exported by `ai/test`; test callers only
// need an assignable generate result.
export function finishStep(
  content: unknown[],
  usage: unknown = TEST_STEP_USAGE,
): any {
  return {
    content: content as never,
    finishReason: { unified: 'stop', raw: 'stop' } as const,
    usage,
    warnings: [],
  };
}

export function fakeMcpClient(result: string | (() => string)): {
  client: McpToolClient;
  calls: () => number;
} {
  let calls = 0;
  return {
    client: {
      async open() {
        return {
          async callTool() {
            calls += 1;
            return typeof result === 'function' ? result() : result;
          },
          async close() {},
        };
      },
    },
    calls: () => calls,
  };
}
