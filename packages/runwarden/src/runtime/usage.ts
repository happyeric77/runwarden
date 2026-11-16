import { calcPrice, type Provider } from '@pydantic/genai-prices';
import type { LanguageModelUsage } from 'ai';

import type {
  InvocationUsage,
  UsagePriceOverride,
  UsagePricingOptions,
  UsageStep,
  UsageTokenCounts,
} from '../contracts/runtime.js';

export interface UsageStepSource {
  usage?: LanguageModelUsage;
  provider?: string;
  model: string;
}

const EMPTY_TOKENS: UsageTokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

export function emptyInvocationUsage(): InvocationUsage {
  return { ...EMPTY_TOKENS, costIncomplete: false, steps: [] };
}

function metric(value: number | undefined): number {
  return value ?? 0;
}

function hasUsage(usage: LanguageModelUsage | undefined): boolean {
  if (!usage) return false;
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.inputTokenDetails.noCacheTokens,
    usage.inputTokenDetails.cacheReadTokens,
    usage.inputTokenDetails.cacheWriteTokens,
    usage.outputTokenDetails.textTokens,
    usage.outputTokenDetails.reasoningTokens,
  ].some((value) => value !== undefined);
}

function tokenCounts(usage: LanguageModelUsage | undefined): UsageTokenCounts {
  if (!usage) return { ...EMPTY_TOKENS };
  const cacheReadTokens = metric(usage.inputTokenDetails.cacheReadTokens);
  const cacheWriteTokens = metric(usage.inputTokenDetails.cacheWriteTokens);
  const reasoningTokens = metric(usage.outputTokenDetails.reasoningTokens);
  return {
    inputTokens:
      usage.inputTokenDetails.noCacheTokens ??
      Math.max(
        metric(usage.inputTokens) - cacheReadTokens - cacheWriteTokens,
        0,
      ),
    outputTokens:
      usage.outputTokenDetails.textTokens ??
      Math.max(metric(usage.outputTokens) - reasoningTokens, 0),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

function inputTotal(
  usage: LanguageModelUsage | undefined,
  tokens: UsageTokenCounts,
): number | undefined {
  if (usage?.inputTokens !== undefined) return usage.inputTokens;
  const details = usage?.inputTokenDetails;
  if (
    details?.noCacheTokens === undefined &&
    details?.cacheReadTokens === undefined &&
    details?.cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
}

function outputTotal(
  usage: LanguageModelUsage | undefined,
  tokens: UsageTokenCounts,
): number | undefined {
  if (usage?.outputTokens !== undefined) return usage.outputTokens;
  const details = usage?.outputTokenDetails;
  if (
    details?.textTokens === undefined &&
    details?.reasoningTokens === undefined
  ) {
    return undefined;
  }
  return tokens.outputTokens + tokens.reasoningTokens;
}

function overrideProvider(override: UsagePriceOverride): Provider {
  return {
    api_pattern: '',
    id: 'runwarden-override',
    name: 'Runwarden price override',
    models: [
      {
        id: override.model,
        match: { equals: override.model },
        prices: {
          input_mtok: override.inputPerMillionTokens,
          output_mtok: override.outputPerMillionTokens,
          ...(override.cacheReadPerMillionTokens !== undefined
            ? { cache_read_mtok: override.cacheReadPerMillionTokens }
            : {}),
          ...(override.cacheWritePerMillionTokens !== undefined
            ? { cache_write_mtok: override.cacheWritePerMillionTokens }
            : {}),
        },
      },
    ],
  };
}

function priceStep(
  source: UsageStepSource,
  tokens: UsageTokenCounts,
  pricing: UsagePricingOptions | undefined,
): number | undefined {
  const input = inputTotal(source.usage, tokens);
  const output = outputTotal(source.usage, tokens);
  if (input === undefined || output === undefined) return undefined;

  const override = pricing?.overrides?.find(
    (candidate) =>
      candidate.model.toLowerCase() === source.model.toLowerCase() &&
      (!candidate.provider ||
        candidate.provider.toLowerCase() === source.provider?.toLowerCase()),
  );

  try {
    const price = calcPrice(
      {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: tokens.cacheReadTokens,
        cache_write_tokens: tokens.cacheWriteTokens,
      },
      source.model,
      override
        ? { provider: overrideProvider(override) }
        : pricing?.providerId
          ? { providerId: pricing.providerId }
          : undefined,
    );
    return price?.total_price;
  } catch {
    // Metering is observational: a bad price table or usage shape must not fail
    // an invocation that otherwise succeeded.
    return undefined;
  }
}

export function buildInvocationUsage(
  sources: readonly UsageStepSource[],
  pricing?: UsagePricingOptions,
): InvocationUsage {
  const steps: UsageStep[] = sources.map((source) => {
    const usageKnown = hasUsage(source.usage);
    const tokens = tokenCounts(source.usage);
    const costUsd = usageKnown ? priceStep(source, tokens, pricing) : undefined;
    return {
      ...tokens,
      ...(source.provider ? { provider: source.provider } : {}),
      model: source.model,
      usageKnown,
      ...(costUsd !== undefined ? { costUsd } : {}),
      costKnown: costUsd !== undefined,
    };
  });

  const knownCosts = steps.flatMap((step) =>
    step.costUsd === undefined ? [] : [step.costUsd],
  );
  return {
    ...EMPTY_TOKENS,
    inputTokens: steps.reduce((total, step) => total + step.inputTokens, 0),
    outputTokens: steps.reduce((total, step) => total + step.outputTokens, 0),
    cacheReadTokens: steps.reduce(
      (total, step) => total + step.cacheReadTokens,
      0,
    ),
    cacheWriteTokens: steps.reduce(
      (total, step) => total + step.cacheWriteTokens,
      0,
    ),
    reasoningTokens: steps.reduce(
      (total, step) => total + step.reasoningTokens,
      0,
    ),
    ...(knownCosts.length > 0
      ? { costUsd: knownCosts.reduce((total, cost) => total + cost, 0) }
      : {}),
    costIncomplete: steps.some((step) => !step.costKnown),
    steps,
  };
}
