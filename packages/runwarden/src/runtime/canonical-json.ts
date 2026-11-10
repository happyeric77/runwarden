import { createHash } from 'node:crypto';

// Stable stringify: object keys sorted, so equality ignores key order.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

// One key per call identity: stable across retries and approval reruns.
export function deriveToolCallIdempotencyKey(
  invocationId: string,
  toolName: string,
  input: unknown,
): string {
  return createHash('sha256')
    .update(`invocation:${invocationId}\n${toolName}\n${canonicalJson(input)}`)
    .digest('hex');
}
