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

  it('does not price partial usage as a complete total', () => {
    const result = buildInvocationUsage([
      {
        usage: {
          inputTokens: undefined,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: 10,
            cacheWriteTokens: undefined,
          },
          outputTokens: undefined,
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: 2,
          },
          totalTokens: undefined,
        },
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    ]);

    expect(result.steps[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10,
      reasoningTokens: 2,
      usageKnown: false,
      costKnown: false,
    });
    expect(result).not.toHaveProperty('costUsd');
    expect(result.costIncomplete).toBe(true);
  });

  it('does not price a zero-valued partial usage as a complete total', () => {
    const result = buildInvocationUsage([
      {
        usage: {
          inputTokens: undefined,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: 0,
            cacheWriteTokens: undefined,
          },
          outputTokens: undefined,
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: 0,
          },
          totalTokens: undefined,
        },
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    ]);

    expect(result.steps[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      usageKnown: false,
      costKnown: false,
    });
    expect(result).not.toHaveProperty('costUsd');
    expect(result.costIncomplete).toBe(true);
  });

  it('ignores invalid token counts instead of failing completion', () => {
    const result = buildInvocationUsage([
      {
        usage: {
          inputTokens: Number.NaN,
          inputTokenDetails: {
            noCacheTokens: 1.5,
            cacheReadTokens: -1,
            cacheWriteTokens: 0,
          },
          outputTokens: 2,
          outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
          totalTokens: 2,
        },
        model: 'gpt-4o-mini',
      },
    ]);

    expect(result.steps[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      usageKnown: false,
      costKnown: false,
    });
    expect(result).not.toHaveProperty('costUsd');
    expect(result.costIncomplete).toBe(true);
  });

  it('accepts token counts larger than a 32-bit integer', () => {
    const result = buildInvocationUsage([
      {
        usage: {
          inputTokens: 2_147_483_648,
          inputTokenDetails: {
            noCacheTokens: 2_147_483_648,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 1,
          outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
          totalTokens: 2_147_483_649,
        },
        model: 'unpriced-model',
      },
    ]);

    expect(result.steps[0]).toMatchObject({
      inputTokens: 2_147_483_648,
      outputTokens: 1,
      usageKnown: true,
      costKnown: false,
    });
  });

  it('clamps overflowing aggregate tokens and marks accounting incomplete', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const stepUsage = {
      inputTokens: max,
      inputTokenDetails: {
        noCacheTokens: max,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 0,
      outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      totalTokens: max,
    };
    const result = buildInvocationUsage(
      [
        { usage: stepUsage, provider: 'local', model: 'private-model' },
        { usage: stepUsage, provider: 'local', model: 'private-model' },
      ],
      { overrides: [override] },
    );

    expect(result).toMatchObject({
      inputTokens: max,
      costIncomplete: true,
    });
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.steps.every((step) => step.costKnown)).toBe(true);
  });

  it('uses the step provider to select the catalog price', () => {
    const result = buildInvocationUsage([
      {
        usage: {
          inputTokens: 1_000_000,
          inputTokenDetails: {
            noCacheTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 1_000_000,
          outputTokenDetails: { textTokens: 1_000_000, reasoningTokens: 0 },
          totalTokens: 2_000_000,
        },
        provider: 'cerebras',
        model: 'gpt-oss-120b',
      },
    ]);

    expect(result.steps[0]).toMatchObject({
      usageKnown: true,
      costKnown: true,
    });
    expect(result.costUsd).toBeCloseTo(1.1, 12);
  });

  it('prefers an explicit provider id over the step provider', () => {
    const result = buildInvocationUsage(
      [
        {
          usage: {
            inputTokens: 1_000_000,
            inputTokenDetails: {
              noCacheTokens: 1_000_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokens: 1_000_000,
            outputTokenDetails: { textTokens: 1_000_000, reasoningTokens: 0 },
            totalTokens: 2_000_000,
          },
          provider: 'cerebras',
          model: 'gpt-oss-120b',
        },
      ],
      { providerId: 'openai' },
    );

    expect(result.steps[0]).toMatchObject({
      usageKnown: true,
      costKnown: true,
    });
    expect(result.costUsd).toBeCloseTo(0.219, 12);
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
