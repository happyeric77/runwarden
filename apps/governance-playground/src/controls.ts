import { openAiCompatible, runWorker, type DatabaseHandle } from 'runwarden';
import { startPlaygroundMcpServer } from './mcp-server.js';
import { createPlaygroundRuntime } from './runtime.js';
import { prompts, type Scenario } from './scenarios.js';
import { scriptedModel } from './scripted.js';
import { seed } from './seed.js';

export const scripted = {
  id: 'scripted',
  label: 'Scripted actor (deterministic)',
};
export async function models() {
  try {
    if (!process.env.MODEL_BASE_URL) throw new Error('Unconfigured');
    const url =
      process.env.MODEL_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '') +
      '/v1/models';
    const response = await fetch(url, {
      headers: process.env.MODEL_API_KEY
        ? { Authorization: `Bearer ${process.env.MODEL_API_KEY}` }
        : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Unavailable');
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const real = (Array.isArray(body.data) ? body.data : []).flatMap((item) =>
      typeof item.id === 'string' && item.id !== 'scripted' ? [item.id] : [],
    );
    return {
      real,
      scripted,
      available: true,
      selected: process.env.MODEL_ID ?? '',
    };
  } catch {
    return { real: [], scripted, available: false, selected: '' };
  }
}

export class ControlError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function stageControls(databaseUrl: string, db: DatabaseHandle) {
  let changing = false;
  let mcp: Awaited<ReturnType<typeof startPlaygroundMcpServer>> | undefined;
  let worker: ReturnType<typeof runWorker> | undefined;
  const sessions = new Map<
    string,
    Awaited<ReturnType<typeof createPlaygroundRuntime>>
  >();
  async function exclusive<T>(action: () => Promise<T>) {
    if (changing) throw new ControlError(409, 'Another run is starting');
    changing = true;
    try {
      const active = await db.pool.query(
        "select 1 from agent_runtime.invocations where status in ('pending', 'running') limit 1",
      );
      if (active.rowCount)
        throw new ControlError(409, 'A run is already active');
      await worker?.stop();
      worker = undefined;
      for (const [id, session] of sessions) {
        const invocation = await session.runtime.getInvocation(id);
        if (invocation?.status !== 'awaiting_approval') {
          await session.db.close();
          sessions.delete(id);
        }
      }
      return await action();
    } finally {
      changing = false;
    }
  }
  function startWorker(
    session: Awaited<ReturnType<typeof createPlaygroundRuntime>>,
  ) {
    worker = runWorker({ ...session, pollIdleMs: 20, pollActiveMs: 10 });
  }
  return {
    run(body: Record<string, unknown>) {
      if (
        typeof body.scenario !== 'string' ||
        !Object.hasOwn(prompts, body.scenario) ||
        typeof body.modelId !== 'string' ||
        !body.modelId.trim() ||
        body.modelId.length > 200 ||
        (body.scenario === 'ask' &&
          (typeof body.text !== 'string' || !body.text.trim()))
      )
        throw new ControlError(
          400,
          'Valid scenario, modelId and ask text are required',
        );
      const scenario = body.scenario as Scenario;
      if (body.modelId !== 'scripted' && !process.env.MODEL_BASE_URL)
        throw new ControlError(400, 'MODEL_BASE_URL is not configured');
      return exclusive(async () => {
        const pending = await db.pool.query(
          "select 1 from agent_runtime.invocations where status = 'awaiting_approval' limit 1",
        );
        if (!pending.rowCount) await seed(databaseUrl);
        mcp ??= await startPlaygroundMcpServer(0);
        const session = await createPlaygroundRuntime({
          connectionString: databaseUrl,
          mcpUrl: mcp.url,
          model:
            body.modelId === 'scripted'
              ? scriptedModel(scenario)
              : openAiCompatible({
                  baseUrl: process.env.MODEL_BASE_URL!,
                  apiKey: process.env.MODEL_API_KEY || 'local-no-key',
                  model: body.modelId as string,
                }),
        });
        try {
          const result = await session.runtime.enqueue({
            scope: 'playground-demo',
            prompt:
              scenario === 'ask' ? (body.text as string) : prompts[scenario],
            metadata: {
              playgroundScenario: scenario,
              playgroundModel: body.modelId,
            },
            maxAttempts: 1,
          });
          sessions.set(result.invocationId, session);
          startWorker(session);
          return result;
        } catch (error) {
          await session.db.close();
          throw error;
        }
      });
    },
    approval(body: Record<string, unknown>) {
      if (
        typeof body.invocationId !== 'string' ||
        !['approve', 'reject'].includes(body.decision as string)
      )
        throw new ControlError(
          400,
          'invocationId and approve/reject decision are required',
        );
      return exclusive(async () => {
        // Use the selected actor again when resuming, not whichever model ran last.
        let session = sessions.get(body.invocationId as string);
        if (!session) {
          const row = await db.pool.query(
            'select status, metadata from agent_runtime.invocations where id::text = $1',
            [body.invocationId],
          );
          if (!row.rowCount)
            throw new ControlError(404, 'Invocation not found');
          if (row.rows[0].status !== 'awaiting_approval')
            throw new ControlError(409, 'Invocation is not awaiting approval');
          const metadata = row.rows[0].metadata ?? {};
          mcp ??= await startPlaygroundMcpServer(0);
          session = await createPlaygroundRuntime({
            connectionString: databaseUrl,
            mcpUrl: mcp.url,
            model:
              metadata.playgroundModel === 'scripted'
                ? scriptedModel(metadata.playgroundScenario)
                : openAiCompatible({
                    baseUrl: process.env.MODEL_BASE_URL ?? '',
                    apiKey: process.env.MODEL_API_KEY || 'local-no-key',
                    model:
                      metadata.playgroundModel || process.env.MODEL_ID || '',
                  }),
          });
          sessions.set(body.invocationId as string, session);
        }
        const invocation = await session.runtime.getInvocation(
          body.invocationId as string,
        );
        if (!invocation) throw new ControlError(404, 'Invocation not found');
        if (invocation.status !== 'awaiting_approval')
          throw new ControlError(409, 'Invocation is not awaiting approval');
        if (body.decision === 'approve') {
          await session.runtime.approveInvocation(body.invocationId as string, {
            resolvedBy: 'stage',
          });
          startWorker(session);
        } else
          await session.runtime.rejectInvocation(body.invocationId as string, {
            resolvedBy: 'stage',
          });
        return { invocationId: body.invocationId, decision: body.decision };
      });
    },
    async close() {
      await worker?.stop();
      await Promise.all(
        [...sessions.values()].map((session) => session.db.close()),
      );
      await mcp?.close();
    },
  };
}
