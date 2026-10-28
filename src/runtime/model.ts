import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export interface OpenAiCompatibleModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}

function withProviderTimeout(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return fetchImpl(input, { ...init, signal });
  };
}

export function openAiCompatible(
  config: OpenAiCompatibleModelConfig,
  fetchImpl: typeof fetch = fetch,
): LanguageModel {
  const baseUrl = required(config.baseUrl, 'baseUrl');
  const apiKey = required(config.apiKey, 'apiKey');
  const model = required(config.model, 'model');
  const timeoutMs = config.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive integer');
  }

  const endpoint = new URL(baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('baseUrl must use http or https');
  }

  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: baseUrl,
    apiKey,
    fetch: withProviderTimeout(fetchImpl, timeoutMs),
    transformRequestBody: (body) =>
      Array.isArray(body.tools)
        ? { ...body, parallel_tool_calls: false }
        : body,
  });

  return provider.chatModel(model);
}
