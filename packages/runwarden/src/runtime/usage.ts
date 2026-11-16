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

const TOKEN_KEYS = Object.keys(EMPTY_TOKENS) as Array<keyof UsageTokenCounts>;

function sumTokens(steps: readonly UsageStep[]): {
  tokens: UsageTokenCounts;
  overflow: boolean;
} {
  const tokens = { ...EMPTY_TOKENS };
  let overflow = false;

  for (const key of TOKEN_KEYS) {
    let total = 0;
    for (const step of steps) {
      const value = step[key];
      if (!Number.isSafeInteger(value) || value < 0) {
        overflow = true;
        continue;
      }
      total += value;
      if (total > Number.MAX_SAFE_INTEGER) {
        overflow = true;
        total = Number.MAX_SAFE_INTEGER;
        break;
      }
    }
    tokens[key] = total;
  }

  return { tokens, overflow };
}

export function usageStepsOverflow(steps: readonly UsageStep[]): boolean {
  return sumTokens(steps).overflow;
}

export function emptyInvocationUsage(): InvocationUsage {
  return { ...EMPTY_TOKENS, costIncomplete: false, steps: [] };
}

function validMetric(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function metric(value: number | undefined): number {
  return validMetric(value) ?? 0;
}

function usageValues(usage: LanguageModelUsage): Array<number | undefined> {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.inputTokenDetails.noCacheTokens,
    usage.inputTokenDetails.cacheReadTokens,
    usage.inputTokenDetails.cacheWriteTokens,
    usage.outputTokenDetails.textTokens,
    usage.outputTokenDetails.reasoningTokens,
  ];
}

function hasUsage(usage: LanguageModelUsage | undefined): boolean {
  return (
    usage !== undefined &&
    usageValues(usage).some((value) => value !== undefined)
  );
}

function hasInvalidUsage(usage: LanguageModelUsage | undefined): boolean {
  return (
    usage !== undefined &&
    usageValues(usage).some(
      (value) => value !== undefined && validMetric(value) === undefined,
    )
  );
}

function tokenCounts(usage: LanguageModelUsage | undefined): UsageTokenCounts {
  if (!usage || hasInvalidUsage(usage)) return { ...EMPTY_TOKENS };
  const cacheReadTokens = metric(usage.inputTokenDetails.cacheReadTokens);
  const cacheWriteTokens = metric(usage.inputTokenDetails.cacheWriteTokens);
  const reasoningTokens = metric(usage.outputTokenDetails.reasoningTokens);
  return {
    inputTokens:
      validMetric(usage.inputTokenDetails.noCacheTokens) ??
      (validMetric(usage.inputTokens) === undefined
        ? 0
        : Math.max(
            validMetric(usage.inputTokens)! -
              cacheReadTokens -
              cacheWriteTokens,
            0,
          )),
    outputTokens:
      validMetric(usage.outputTokenDetails.textTokens) ??
      (validMetric(usage.outputTokens) === undefined
        ? 0
        : Math.max(validMetric(usage.outputTokens)! - reasoningTokens, 0)),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

function inputTotal(usage: LanguageModelUsage | undefined): number | undefined {
  if (!usage || hasInvalidUsage(usage)) return undefined;
  const input = validMetric(usage.inputTokens);
  if (input !== undefined) return input;
  const details = usage.inputTokenDetails;
  const noCache = validMetric(details.noCacheTokens);
  const cacheRead = validMetric(details.cacheReadTokens);
  const cacheWrite = validMetric(details.cacheWriteTokens);
  if (
    noCache === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return noCache + cacheRead + cacheWrite;
}

function outputTotal(
  usage: LanguageModelUsage | undefined,
): number | undefined {
  if (!usage || hasInvalidUsage(usage)) return undefined;
  const output = validMetric(usage.outputTokens);
  if (output !== undefined) return output;
  const details = usage.outputTokenDetails;
  const text = validMetric(details.textTokens);
  const reasoning = validMetric(details.reasoningTokens);
  if (text === undefined || reasoning === undefined) return undefined;
  return text + reasoning;
}

const PROVIDER_ALIASES: Record<string, string> = {
  'amazon-bedrock': 'aws',
  'google-vertex': 'google',
  togetherai: 'together',
  xai: 'x-ai',
  moonshot: 'moonshotai',
  zhipu: 'zhipuai',
};

function catalogProviderId(provider: string): string {
  const base = provider.toLowerCase().split('.')[0] ?? provider.toLowerCase();
  return PROVIDER_ALIASES[base] ?? base;
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
  pricing: UsagePricingOptions | undefined,
): number | undefined {
  const input = inputTotal(source.usage);
  const output = outputTotal(source.usage);
  if (input === undefined || output === undefined) return undefined;

  const override = pricing?.overrides?.find(
    (candidate) =>
      candidate.model.toLowerCase() === source.model.toLowerCase() &&
      (!candidate.provider ||
        candidate.provider.toLowerCase() === source.provider?.toLowerCase()),
  );
  const providerId =
    pricing?.providerId ??
    (source.provider ? catalogProviderId(source.provider) : undefined);

  try {
    const price = calcPrice(
      {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: metric(
          source.usage?.inputTokenDetails.cacheReadTokens,
        ),
        cache_write_tokens: metric(
          source.usage?.inputTokenDetails.cacheWriteTokens,
        ),
      },
      source.model,
      override
        ? { provider: overrideProvider(override) }
        : providerId
          ? { providerId }
          : undefined,
    );
    const total = price?.total_price;
    return total !== undefined &&
      Number.isFinite(total) &&
      total >= 0 &&
      total < 1e18
      ? total
      : undefined;
  } catch {
    // Metering is observational: a bad price table or usage shape must not fail
    // an invocation that otherwise succeeded.
    return undefined;
  }
}

export function buildUsageStep(
  source: UsageStepSource,
  pricing?: UsagePricingOptions,
): UsageStep {
  const usageKnown =
    hasUsage(source.usage) &&
    !hasInvalidUsage(source.usage) &&
    inputTotal(source.usage) !== undefined &&
    outputTotal(source.usage) !== undefined;
  const tokens = tokenCounts(source.usage);
  const costUsd = usageKnown ? priceStep(source, pricing) : undefined;
  return {
    ...tokens,
    ...(source.provider ? { provider: source.provider } : {}),
    model: source.model,
    usageKnown,
    ...(costUsd !== undefined ? { costUsd } : {}),
    costKnown: costUsd !== undefined,
  };
}

export function aggregateUsageSteps(
  steps: readonly UsageStep[],
): InvocationUsage {
  const knownCosts = steps.flatMap((step) =>
    step.costUsd === undefined ? [] : [step.costUsd],
  );
  const knownCostTotal =
    knownCosts.length > 0
      ? knownCosts.reduce((total, cost) => total + cost, 0)
      : undefined;
  const costUsd =
    knownCostTotal !== undefined &&
    Number.isFinite(knownCostTotal) &&
    knownCostTotal < 1e18
      ? knownCostTotal
      : undefined;
  const { tokens: totals, overflow: tokensIncomplete } = sumTokens(steps);
  return {
    ...totals,
    ...(costUsd !== undefined ? { costUsd } : {}),
    costIncomplete:
      tokensIncomplete ||
      steps.some((step) => !step.costKnown) ||
      (knownCosts.length > 0 && costUsd === undefined),
    steps: [...steps],
  };
}

export function buildInvocationUsage(
  sources: readonly UsageStepSource[],
  pricing?: UsagePricingOptions,
): InvocationUsage {
  return aggregateUsageSteps(
    sources.map((source) => buildUsageStep(source, pricing)),
  );
}
