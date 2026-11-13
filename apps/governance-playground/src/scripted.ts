// Deterministic actor through the real runtime and MCP, never a live provider.
import { MockLanguageModelV4 } from 'ai/test';
import type { Scenario } from './scenarios.js';

export function scriptedModel(scenario: Scenario) {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const results = prompt.flatMap((message) =>
        message.role === 'tool' ? message.content : [],
      );
      const denied = results.length > 0;
      const completed = results.filter(
        (result) =>
          result.type === 'tool-result' &&
          ['json', 'text'].includes(result.output.type),
      ).length;
      const calls =
        scenario === 'refund-three'
          ? [
              { orderId: 'ord_01', amount: 25 },
              { orderId: 'ord_02', amount: 49.5 },
              { orderId: 'ord_06', amount: 15 },
            ]
          : scenario === 'refund-large'
            ? [{ orderId: 'ord_08', amount: 200 }]
            : [
                {
                  orderId: 'ord_03',
                  amount: 50,
                  ...(scenario === 'refund-wrong-account'
                    ? { destinationCustomerId: denied ? 'cus_03' : 'cus_05' }
                    : {}),
                },
              ];
      const selected =
        scenario === 'ask'
          ? []
          : scenario === 'refund-three' && !denied
            ? calls
            : calls.slice(completed, completed + 1);
      return {
        content: selected.length
          ? selected.map((input, index) => ({
              type: 'tool-call' as const,
              toolCallId: `scripted-${results.length}-${index}`,
              toolName: 'issue_refund',
              input: JSON.stringify(input),
            }))
          : [
              {
                type: 'text' as const,
                text:
                  scenario === 'email-claim'
                    ? 'Refund completed and email sent.'
                    : scenario === 'ask'
                      ? 'Scripted actor supports the fixed Missions only. Select an environment model for custom tasks.'
                      : 'Refund task completed.',
              },
            ],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
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
      };
    },
  });
}
