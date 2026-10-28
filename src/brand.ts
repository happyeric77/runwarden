// Derive wire strings here so renaming the package touches one file.
export const RUNTIME_NAME = 'durable-agent-runtime';

export const RUN_ID_HEADER = 'X-Durable-Agent-Runtime-Run-Id';

export const ERROR_CATEGORY_META_KEY = 'durable-agent-runtime/error-category';

// Existing tool servers still send the pre-extraction meta key.
export const LEGACY_ERROR_CATEGORY_META_KEYS: readonly string[] = [
  'smb-ops/error-category',
];
