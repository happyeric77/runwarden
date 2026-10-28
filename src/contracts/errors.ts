export type AgentRuntimeErrorKind = 'timeout' | 'failure';

/**
 * The one error type the runtime surfaces. `kind` distinguishes a deadline
 * expiry (`timeout`) from every other failure; `diagnostics` carries
 * machine-readable detail (for example `{ code: 'approval_required' }`).
 */
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
