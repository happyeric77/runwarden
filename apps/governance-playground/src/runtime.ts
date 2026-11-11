import {
  createDb,
  defineRuntime,
  initDb,
  openAiCompatible,
  type DatabaseHandle,
  type DefineRuntimeOptions,
  type Runtime,
} from 'runwarden';

import { systemPrompt } from './prompt.js';
import { tools } from './tools.js';

const TOOL_NAMES = tools.map((tool) => tool.name);

export async function createPlaygroundRuntime(input: {
  connectionString: string;
  mcpUrl: string;
  model?: DefineRuntimeOptions['model'];
}): Promise<{ runtime: Runtime; db: DatabaseHandle }> {
  const db = createDb(input.connectionString);
  await initDb(db);
  const runtime = defineRuntime({
    db,
    model:
      input.model ??
      openAiCompatible({
        baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
        apiKey: process.env.MODEL_API_KEY ?? '',
        model: process.env.MODEL_ID ?? 'gpt-4o-mini',
      }),
    mcpServers: [{ name: 'playground', url: input.mcpUrl, tools: TOOL_NAMES }],
    tools,
    loadSystemPrompt: async () => systemPrompt,
    loadHistory: async () => [],
    policies: {
      exactlyOneToolCallPerStep: true,
      correctionBudget: 3,
      toolAllowlist: TOOL_NAMES,
      maxToolCallsPerInvocation: 12,
      maxDurationMs: 120_000,
    },
    onPolicyDecision: (decision) => {
      console.log(
        `[policy] rule=${decision.rule} decision=${decision.decision} tool=${decision.toolName ?? ''}`,
      );
    },
  });
  return { runtime, db };
}
