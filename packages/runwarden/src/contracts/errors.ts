import type { InvocationUsage } from './runtime.js';

export type AgentRuntimeErrorKind = 'timeout' | 'failure' | 'budget';

export interface AgentRuntimeErrorOptions extends ErrorOptions {
  usage?: InvocationUsage;
}

export class AgentRuntimeError extends Error {
  readonly usage?: InvocationUsage;

  constructor(
    readonly kind: AgentRuntimeErrorKind,
    message: string,
    readonly diagnostics: Record<string, unknown> = {},
    options: AgentRuntimeErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'AgentRuntimeError';
    this.usage = options.usage;
  }
}
