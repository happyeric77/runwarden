import { createDb, defineRuntime } from '../../src/index';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const db = createDb(connectionString);
try {
  const runtime = defineRuntime({
    db,
    provider: {
      baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: process.env.MODEL_API_KEY ?? '',
      model: process.env.MODEL_ID ?? 'gpt-4o-mini',
    },
  });
  const prompt = process.argv[2] ?? 'Say hello in one short sentence.';
  const result = await runtime.invoke(
    { scope: 'example', prompt },
    { waitTimeoutMs: 60_000 },
  );
  console.log(`[app] invocation ${result.invocationId}: ${result.text}`);
} finally {
  await db.close();
}
