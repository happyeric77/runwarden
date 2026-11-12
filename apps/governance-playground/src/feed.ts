import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createDb, initDb } from 'runwarden';

import { buildCases, type CaseEvent } from './cases.js';

export async function startFeedServer(port: number) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const page = await readFile(new URL('./feed-page.html', import.meta.url));
  const db = createDb(databaseUrl);
  try {
    await initDb(db);
  } catch (error) {
    await db.close();
    throw error;
  }
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    if (req.url === '/') {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page);
      return;
    }
    if (req.url !== '/api/events' && req.url !== '/api/cases') {
      res.writeHead(404).end();
      return;
    }
    try {
      if (req.url === '/api/cases') {
        const { rows } = await db.pool.query<CaseEvent>(`
          select * from (
            select created_at as at, 'invocation' as kind, id::text as "invocationId",
                   null::text as tool, null::text as rule, null::text as decision,
                   status::text as status, null::jsonb as snapshot
              from agent_runtime.invocations
            union all
            select created_at, 'decision', invocation_id::text, tool_name, rule, decision,
                   null::text, null::jsonb from agent_runtime.policy_decisions
            union all
            select coalesce(completed_at, requested_at), 'audit', invocation_id::text, tool_name,
                   null::text, null::text, status::text, request_snapshot
              from agent_runtime.tool_call_audits
          ) events order by at asc
        `);
        res
          .writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          .end(JSON.stringify({ cases: buildCases(rows) }));
        return;
      }
      const events = await db.pool.query(`
        select * from (
          (select updated_at as at, 'invocation' as kind, id::text as "invocationId",
                  null::text as tool, null::text as rule, null::text as decision,
                  status::text as status, 'Invocation ' || id || ' (' || scope || '): ' || status::text as summary
             from agent_runtime.invocations order by updated_at desc, id desc limit 100)
          union all
          (select created_at, 'decision', invocation_id::text, tool_name, rule, decision,
                  null::text, 'Invocation ' || invocation_id || ': ' || rule || ' ' || decision || coalesce(' (' || tool_name || ')', '')
             from agent_runtime.policy_decisions order by created_at desc, id desc limit 100)
          union all
          (select coalesce(completed_at, requested_at), 'audit', invocation_id::text, tool_name,
                  null::text, null::text, status::text,
                  'Invocation ' || invocation_id || ': ' || tool_name || ' ' || status::text
             from agent_runtime.tool_call_audits order by coalesce(completed_at, requested_at) desc, id desc limit 100)
        ) events order by at desc limit 100
      `);
      const stats = await db.pool.query(`
        select (select count(*)::int from agent_runtime.invocations) as invocations,
               (select count(*)::int from agent_runtime.policy_decisions where decision = 'deny') as denies,
               (select count(*)::int from agent_runtime.policy_decisions where decision = 'correction_issued') as corrections,
               (select count(*)::int from agent_runtime.invocations where status = 'awaiting_approval') as "awaitingApproval"
      `);
      const pendingApprovals = await db.pool.query(`
        select id::text as "invocationId", pending_tool_call->>'toolName' as tool,
               pending_tool_call->'input' as input, created_at as "createdAt"
          from agent_runtime.invocations
         where status = 'awaiting_approval'
         order by created_at, id
      `);
      res
        .writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end(
          JSON.stringify({
            events: events.rows,
            stats: stats.rows[0],
            pendingApprovals: pendingApprovals.rows,
          }),
        );
    } catch (error) {
      console.error('Feed query failed:', error);
      res
        .writeHead(500, { 'Content-Type': 'application/json' })
        .end('{"error":"Feed query failed"}');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, process.env.FEED_HOST ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await db.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Feed did not bind a port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        await db.close();
      }
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startFeedServer(Number(process.env.FEED_PORT ?? 43_123))
    .then(({ url }) => console.log(`Feed listening at ${url}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
