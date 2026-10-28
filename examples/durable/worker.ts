/**
 * Durable-mode worker: claims invocations from Postgres and executes them.
 * Run the app (app.ts) in another terminal to enqueue work for it.
 */
import { createDb, defineRuntime, runWorker } from '../../src/index';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const db = createDb(connectionString);
const runtime = defineRuntime({
  db,
  provider: {
    baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.MODEL_API_KEY ?? '',
    model: process.env.MODEL_ID ?? 'gpt-4o-mini',
  },
  loadSystemPrompt: async () => 'You are a helpful assistant.',
  loadHistory: async () => [],
});

const worker = runWorker({
  runtime,
  db,
  onSucceeded: async (invocation, result) => {
    console.log(`[worker] ${invocation.id} succeeded: ${result.text}`);
  },
  onFailed: async (invocation, error) => {
    console.error(`[worker] ${invocation.id} failed: ${error.message}`);
  },
});

console.log('[worker] waiting for invocations (Ctrl+C to stop)');
process.on('SIGINT', () => {
  void worker.stop().then(async () => {
    await db.close();
    process.exit(0);
  });
});
