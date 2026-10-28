/**
 * Product-name-derived constants, centralized in one place.
 *
 * The package name is still a codename during the private phase; every
 * wire-visible string (MCP client name, run-id header, error-category meta
 * key) derives from here so a rename touches exactly one file.
 */
export const RUNTIME_NAME = 'durable-agent-runtime';

/** Header that correlates MCP calls with the invocation run that caused them. */
export const RUN_ID_HEADER = 'X-Durable-Agent-Runtime-Run-Id';

/** `_meta` key an MCP tool result uses to mark an application error as correctable. */
export const ERROR_CATEGORY_META_KEY = 'durable-agent-runtime/error-category';

/**
 * Meta keys honored for backward compatibility during migration.
 * The pre-extraction runtime marked correctable errors with
 * `smb-ops/error-category`; tool servers built against it keep working.
 */
export const LEGACY_ERROR_CATEGORY_META_KEYS: readonly string[] = [
  'smb-ops/error-category',
];
