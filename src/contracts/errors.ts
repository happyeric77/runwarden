export type AgentRuntimeErrorKind = 'timeout' | 'failure';

export class AgentRuntimeError extends Error {
  constructor(
    readonly kind: AgentRuntimeErrorKind,
    message: string,
    readonly diagnostics: Record<string, unknown> = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'AgentRuntimeError';
  }
}
