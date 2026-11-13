import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import { createDb } from 'runwarden';
import { expect, it } from 'vitest';
import { startFeedServer } from './feed.js';

it('discovers models without leaking credentials and runs governed stage controls', async () => {
  const previous = { ...process.env };
  const port = 35000 + Math.floor(Math.random() * 3000);
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpdir(), `stage-${randomUUID()}`),
    user: 'postgres',
    password: 'password',
    port,
    persistent: true,
    postgresFlags: ['-k', tmpdir()],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stage');
  const stub = createServer((req, res) => {
    expect(req.url).toBe('/v1/models');
    expect(req.headers.authorization).toBe('Bearer test-secret');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = (stub.address() as { port: number }).port;
  let feed: Awaited<ReturnType<typeof startFeedServer>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  const browser = process.env.PLAYWRIGHT_MODULE
    ? await (
        await import(process.env.PLAYWRIGHT_MODULE)
      ).chromium.launch({
        executablePath: process.env.CHROME_PATH,
        headless: true,
      })
    : undefined;
  const page = await browser?.newPage({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
  });
  try {
    process.env.DATABASE_URL = `postgres://postgres:password@localhost:${port}/stage`;
    process.env.MODEL_BASE_URL = `http://127.0.0.1:${stubPort}/v1`;
    process.env.MODEL_API_KEY = 'test-secret';
    process.env.MODEL_ID = 'local-model';
    feed = await startFeedServer(0);
    db = createDb(process.env.DATABASE_URL);
    const modelResponse = await fetch(`${feed.url}/api/models`);
    const text = await modelResponse.text();
    expect(text).not.toContain('test-secret');
    expect(JSON.parse(text)).toEqual({
      real: ['local-model'],
      scripted: { id: 'scripted', label: 'Scripted actor (deterministic)' },
      available: true,
      selected: 'local-model',
    });
    await new Promise<void>((resolve, reject) =>
      stub.close((error) => (error ? reject(error) : resolve())),
    );
    expect(await (await fetch(`${feed.url}/api/models`)).json()).toMatchObject({
      real: [],
      available: false,
      scripted: { id: 'scripted' },
    });
    delete process.env.MODEL_BASE_URL;
    expect(await (await fetch(`${feed.url}/api/models`)).json()).toMatchObject({
      real: [],
      available: false,
    });
    const post = (route: string, body: unknown) =>
      fetch(`${feed!.url}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(
      (await post('/api/run', { scenario: 'ask', modelId: 'scripted' })).status,
    ).toBe(400);
    expect(
      (await post('/api/run', { scenario: 'unknown', modelId: 'scripted' }))
        .status,
    ).toBe(400);
    expect(
      (
        await fetch(`${feed.url}/api/run`, {
          method: 'POST',
          headers: { Origin: 'https://untrusted.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    if (page) {
      await page.goto(feed.url);
      await page.locator('#model').selectOption('scripted');
      await page
        .getByRole('button', { name: 'Run refund-three', exact: true })
        .click();
      await page
        .getByText('Case closed: 3 refunds, 3 audit rows.', { exact: true })
        .waitFor();
      await page.screenshot({
        path: `${process.env.STAGE_SCREENSHOTS}/stage-controls-burst.png`,
        fullPage: true,
      });
      await page
        .getByRole('button', { name: 'Run refund-large', exact: true })
        .click();
      await page.locator('#approval-controls').waitFor({ state: 'visible' });
      expect(await page.locator('#approval-input').textContent()).toContain(
        '$200',
      );
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await page
        .getByText('Case closed: 1 refunds, 1 audit rows.', { exact: true })
        .waitFor();
      await page.screenshot({
        path: `${process.env.STAGE_SCREENSHOTS}/stage-controls-approved.png`,
        fullPage: true,
      });
      expect(
        (
          await db.pool.query(
            "select count(*)::int as n from refunds where order_id='ord_08'",
          )
        ).rows[0].n,
      ).toBe(1);
    }
    const burst = await post('/api/run', {
      scenario: 'refund-three',
      modelId: 'scripted',
    });
    expect(burst.status).toBe(202);
    const { invocationId } = (await burst.json()) as { invocationId: string };
    expect(
      (
        await post('/api/run', {
          scenario: 'refund-three',
          modelId: 'scripted',
        })
      ).status,
    ).toBe(409);
    await wait(invocationId, 'succeeded');
    const cases = (await (await fetch(`${feed.url}/api/cases`)).json()) as {
      cases: {
        invocationId: string;
        scenario: string;
        orders: unknown[];
        judge: string[];
      }[];
    };
    expect(
      cases.cases.find((item) => item.invocationId === invocationId),
    ).toMatchObject({
      scenario: 'refund-three',
      orders: expect.any(Array),
      judge: expect.arrayContaining(['Case closed: 3 refunds, 3 audit rows.']),
    });
    expect(
      (
        await db.pool.query(
          "select count(*)::int as n from agent_runtime.tool_call_audits where invocation_id=$1 and status='succeeded'",
          [invocationId],
        )
      ).rows[0].n,
    ).toBe(3);
    for (const decision of ['approve', 'reject']) {
      const response = await post('/api/run', {
        scenario: 'refund-large',
        modelId: 'scripted',
      });
      expect(response.status).toBe(202);
      const id = ((await response.json()) as { invocationId: string })
        .invocationId;
      await wait(id, 'awaiting_approval');
      expect(
        (
          await db.pool.query(
            "select count(*)::int as n from refunds where order_id='ord_08'",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await post('/api/approvals', { invocationId: id, decision })).status,
      ).toBe(200);
      await wait(id, decision === 'approve' ? 'succeeded' : 'cancelled');
      expect(
        (
          await db.pool.query(
            "select count(*)::int as n from refunds where order_id='ord_08'",
          )
        ).rows[0].n,
      ).toBe(decision === 'approve' ? 1 : 0);
      expect(
        (await post('/api/approvals', { invocationId: id, decision })).status,
      ).toBe(409);
    }
    expect(
      (
        await post('/api/approvals', {
          invocationId: '9999999',
          decision: 'approve',
        })
      ).status,
    ).toBe(404);
    for (const scenario of ['refund-wrong-account', 'email-claim', 'ask']) {
      const response = await post('/api/run', {
        scenario,
        modelId: 'scripted',
        text: 'Show the sandbox',
      });
      expect(response.status).toBe(202);
      await wait(
        ((await response.json()) as { invocationId: string }).invocationId,
        'succeeded',
      );
    }
    process.env.MODEL_BASE_URL = `http://127.0.0.1:${stubPort}/v1`;
    const failed = await post('/api/run', {
      scenario: 'ask',
      modelId: 'offline-model',
      text: 'Hello',
    });
    expect(failed.status).toBe(202);
    await wait(
      ((await failed.json()) as { invocationId: string }).invocationId,
      'failed',
    );
    async function wait(id: string, status: string) {
      await expect
        .poll(
          async () =>
            (
              await db!.pool.query(
                'select status from agent_runtime.invocations where id=$1',
                [id],
              )
            ).rows[0]?.status,
          { timeout: 20000 },
        )
        .toBe(status);
    }
  } finally {
    await browser?.close();
    await feed?.close();
    await db?.close();
    stub.close();
    await pg.stop();
    for (const key of [
      'DATABASE_URL',
      'MODEL_BASE_URL',
      'MODEL_API_KEY',
      'MODEL_ID',
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

it('renders Compose model environment passthrough and empty defaults', () => {
  for (const values of [
    {
      MODEL_BASE_URL: 'http://host.docker.internal:11434/v1',
      MODEL_API_KEY: 'compose-test-key',
      MODEL_ID: 'local-model',
    },
    { MODEL_BASE_URL: '', MODEL_API_KEY: '', MODEL_ID: '' },
  ]) {
    const config = JSON.parse(
      execFileSync(
        'docker',
        ['compose', '-f', 'docker-compose.yml', 'config', '--format', 'json'],
        { env: { ...process.env, ...values }, encoding: 'utf8' },
      ),
    );
    expect(config.services.feed.environment).toMatchObject(values);
  }
});
