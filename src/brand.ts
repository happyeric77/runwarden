/** Wire-visible strings derive from the package name here, so a rename touches one file. */
export const RUNTIME_NAME = 'durable-agent-runtime';

/** Header that correlates MCP calls with the invocation run that caused them. */
export const RUN_ID_HEADER = 'X-Durable-Agent-Runtime-Run-Id';

/** `_meta` key an MCP tool result uses to mark an application error as correctable. */
export const ERROR_CATEGORY_META_KEY = 'durable-agent-runtime/error-category';

/** Read-compat for tool servers built against the pre-extraction runtime. */
export const LEGACY_ERROR_CATEGORY_META_KEYS: readonly string[] = [
  'smb-ops/error-category',
];
