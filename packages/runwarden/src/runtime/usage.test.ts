import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';

import { buildInvocationUsage } from './usage.js';

function usage(): LanguageModelUsage {
  return {
    inputTokens: 10,
    inputTokenDetails: {
      noCacheTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 3,
    },
    outputTokens: 6,
    outputTokenDetails: { textTokens: 4, reasoningTokens: 2 },
    totalTokens: 16,
  };
}

const override = {
  model: 'private-model',
  inputPerMillionTokens: 1,
  outputPerMillionTokens: 2,
  cacheReadPerMillionTokens: 0.5,
  cacheWritePerMillionTokens: 0.25,
};

describe('buildInvocationUsage', () => {
  it('meters every step and keeps cache and reasoning tokens separate', () => {
    const result = buildInvocationUsage(
      [
        { usage: usage(), provider: 'local', model: 'private-model' },
        { usage: usage(), provider: 'local', model: 'private-model' },
      ],
      { overrides: [override] },
    );

    expect(result).toMatchObject({
      inputTokens: 8,
      outputTokens: 8,
      cacheReadTokens: 6,
      cacheWriteTokens: 6,
      reasoningTokens: 4,
      costIncomplete: false,
    });
    expect(result.costUsd).toBeCloseTo(0.0000365, 12);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({
      inputTokens: 4,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
      provider: 'local',
      model: 'private-model',
      usageKnown: true,
      costKnown: true,
    });
    expect(result.steps[0]?.costUsd).toBeCloseTo(0.00001825, 12);
  });

  it('keeps known tokens but leaves cost unknown when usage or pricing is missing', () => {
    const result = buildInvocationUsage([
      { usage: usage(), provider: 'local', model: 'unpriced-model' },
      { provider: 'local', model: 'unpriced-model' },
    ]);

    expect(result).toMatchObject({
      inputTokens: 4,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
      costIncomplete: true,
    });
    expect(result).not.toHaveProperty('costUsd');
    expect(result.steps[0]).toMatchObject({
      inputTokens: 4,
      usageKnown: true,
      costKnown: false,
    });
    expect(result.steps[0]).not.toHaveProperty('costUsd');
    expect(result.steps[1]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      usageKnown: false,
      costKnown: false,
    });
    expect(result.steps[1]).not.toHaveProperty('costUsd');
  });

  it('prefers a user override over the built-in model price', () => {
    const result = buildInvocationUsage(
      [{ usage: usage(), model: 'gpt-4o-mini' }],
      {
        overrides: [
          {
            model: 'gpt-4o-mini',
            inputPerMillionTokens: 1000,
            outputPerMillionTokens: 2000,
            cacheReadPerMillionTokens: 100,
            cacheWritePerMillionTokens: 200,
          },
        ],
      },
    );

    expect(result.costIncomplete).toBe(false);
    expect(result.costUsd).toBeCloseTo(0.0169, 12);
  });
});
