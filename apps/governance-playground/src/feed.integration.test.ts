import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { createDb, initDb } from 'runwarden';
import { expect, it } from 'vitest';

import { buildCases, type CaseEvent } from './cases.js';
import { startFeedServer } from './feed.js';

it('groups a denied burst and three successful refunds into a case', () => {
  const base: CaseEvent = {
    at: new Date(),
    kind: 'decision',
    invocationId: 'case',
    tool: 'issue_refund',
    rule: 'exactly_one',
    decision: 'deny',
    status: null,
    snapshot: null,
  };
  const events: CaseEvent[] = [
    {
      ...base,
      kind: 'invocation',
      status: 'succeeded',
      tool: null,
      rule: null,
      decision: null,
    },
    base,
    base,
    base,
    { ...base, tool: null, decision: 'correction_issued' },
    ...['ord_01', 'ord_02', 'ord_06'].map((orderId) => ({
      ...base,
      kind: 'audit',
      rule: null,
      decision: null,
      status: 'succeeded',
      snapshot: { orderId, amount: 25 },
    })),
  ];
  const [result] = buildCases(events);
  expect(result!.orders).toHaveLength(3);
  expect(result!.orders.every((order) => order.status === 'REFUNDED')).toBe(
    true,
  );
  expect(result!.judge).toEqual([
    'Agent tried 3 tool calls in one step. Denied.',
    'Correction issued. Retry one by one.',
    'Executed: issue_refund ord_01.',
    'Executed: issue_refund ord_02.',
    'Executed: issue_refund ord_06.',
    'Case closed: 3 refunds, 3 audit rows.',
  ]);
  const noExecutions = events.filter((event) => event.kind !== 'audit');
  expect(buildCases(noExecutions)[0]!.judge.at(-1)).toBe(
    'CLAIM UNVERIFIED: model replied, but no tool execution succeeded.',
  );
  expect(
    buildCases(
      noExecutions.map((event) =>
        event.kind === 'invocation' ? { ...event, status: 'failed' } : event,
      ),
    )[0]!.judge.at(-1),
  ).toBe('Case failed: invocation failed. Check Evidence.');
  expect(buildCases([{ ...base, rule: 'input_validation' }])[0]!.judge).toEqual(
    ['Wrong account. Denied before it ran.'],
  );
});

it('serves a read-only, ordered feed and global counts without a model', async () => {
  const port = 32_000 + Math.floor(Math.random() * 3_000);
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpdir(), `gp-feed-pg-${randomUUID()}`),
    user: 'postgres',
    password: 'password',
    port,
    persistent: true,
    postgresFlags: process.platform === 'win32' ? [] : ['-k', tmpdir()],
  });
  const previousUrl = process.env.DATABASE_URL;
  await pg.initialise();
  await pg.start();
  let db: ReturnType<typeof createDb> | undefined;
  let feed: Awaited<ReturnType<typeof startFeedServer>> | undefined;
  try {
    await pg.createDatabase('gp_feed');
    process.env.DATABASE_URL = `postgres://postgres:password@localhost:${port}/gp_feed`;
    db = createDb(process.env.DATABASE_URL);
    await initDb(db);
    const invocation = await db.pool.query<{ id: string }>(
      `insert into agent_runtime.invocations (scope, input, status, updated_at, metadata)
       values ('feed-test', '{}', 'awaiting_approval', '2024-01-01T00:00:00Z', '{"playgroundScenario":"refund-large"}') returning id`,
    );
    const id = invocation.rows[0]!.id;
    const runId = randomUUID();
    await db.pool.query(
      `insert into agent_runtime.policy_decisions (scope, invocation_id, run_id, rule, decision, created_at)
       values ('feed-test', $1, $2, 'exactly_one', 'deny', '2024-01-01T00:00:01Z'),
              ('feed-test', $1, $2, 'exactly_one', 'correction_issued', '2024-01-01T00:00:02Z')`,
      [id, runId],
    );
    await db.pool.query(
      `insert into agent_runtime.tool_call_audits (scope, invocation_id, tool_name, status, requested_at, completed_at)
       values ('feed-test', $1, 'issue_refund', 'succeeded', '2024-01-01T00:00:02Z', '2024-01-01T00:00:03Z')`,
      [id],
    );
    feed = await startFeedServer(0);
    const response = await fetch(`${feed.url}/api/events`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      stats: unknown;
      events: Array<{
        at: string;
        kind: string;
        invocationId: string;
        decision: string | null;
        summary: string;
      }>;
    };
    expect(data.stats).toEqual({
      invocations: 1,
      denies: 1,
      corrections: 1,
      awaitingApproval: 1,
    });
    expect(data.events.map((event: { kind: string }) => event.kind)).toEqual([
      'audit',
      'decision',
      'decision',
      'invocation',
    ]);
    expect(
      data.events.map((event: { decision: string | null }) => event.decision),
    ).toEqual([null, 'correction_issued', 'deny', null]);
    for (const event of data.events) {
      expect(Object.keys(event).sort()).toEqual([
        'at',
        'decision',
        'invocationId',
        'kind',
        'rule',
        'status',
        'summary',
        'tool',
      ]);
      expect(event.invocationId).toBe(id);
      expect(event.summary).toEqual(expect.any(String));
    }
    expect(data.events.map((event: { at: string }) => event.at)).toEqual([
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:00.000Z',
    ]);
    expect(data.events[0]).toMatchObject({
      tool: 'issue_refund',
      status: 'succeeded',
    });
    expect(data.events[3]).toMatchObject({
      status: 'awaiting_approval',
      summary: expect.stringContaining('feed-test'),
    });
    const casesResponse = await fetch(`${feed.url}/api/cases`);
    expect(casesResponse.status).toBe(200);
    const cases = (await casesResponse.json()) as {
      cases: Array<{ invocationId: string; judge: string[] }>;
    };
    expect(cases.cases).toHaveLength(1);
    expect(cases.cases[0]).toMatchObject({
      invocationId: id,
      status: 'awaiting_approval',
      scenario: 'refund-large',
    });
    expect(cases.cases[0]!.judge).toContain(
      'Correction issued. Retry one by one.',
    );
    const page = await fetch(feed.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    for (const marker of [
      'Governance Demo Stage',
      'Missions',
      'Shop Floor',
      'Policy Gate',
      'Judge',
      'Evidence',
    ])
      expect(html).toContain(marker);
    expect(
      (await fetch(`${feed.url}/api/events`, { method: 'POST' })).status,
    ).toBe(405);
    expect((await fetch(`${feed.url}/missing`)).status).toBe(404);
  } finally {
    await feed?.close();
    await db?.close();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await pg.stop();
  }
});
