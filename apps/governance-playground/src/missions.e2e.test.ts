/// <reference lib="dom" />
// Opt-in real browser + runtime + Postgres acceptance. Fake model, no API fixtures.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import EmbeddedPostgres from 'embedded-postgres';
import { AgentRuntimeError, runWorker } from 'runwarden';
import { expect, it } from 'vitest';

import { startFeedServer } from './feed.js';
import { startPlaygroundMcpServer } from './mcp-server.js';
import { createPlaygroundRuntime } from './runtime.js';
import { seed } from './seed.js';
import type { buildCases } from './cases.js';

// Reuse an installed Playwright; do not add a browser dependency to the playground.
it.skipIf(!process.env.PLAYWRIGHT_MODULE)(
  'selects runtime-created Missions through the real feed in Chrome (fake model)',
  async () => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
    const port = 29_000 + Math.floor(Math.random() * 3_000);
    const connectionString = `postgres://postgres:password@localhost:${port}/missions`;
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(tmpdir(), `gp-missions-${randomUUID()}`),
      user: 'postgres',
      password: 'password',
      port,
      persistent: true,
      postgresFlags: process.platform === 'win32' ? [] : ['-k', tmpdir()],
    });
    const previousUrl = process.env.DATABASE_URL;
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('missions');
    process.env.DATABASE_URL = connectionString;
    const steps = new Map<string, number>();
    const call = (
      orderId: string,
      amount: number,
      destinationCustomerId?: string,
    ) => ({
      type: 'tool-call',
      toolCallId: randomUUID(),
      toolName: 'issue_refund',
      input: JSON.stringify({ orderId, amount, destinationCustomerId }),
    });
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const userContent = prompt.find(
          (message) => message.role === 'user',
        )!.content;
        const scenario =
          typeof userContent === 'string'
            ? userContent
            : (userContent as Array<{ text?: string }>)
                .map((part) => part.text ?? '')
                .join('');
        if (scenario === 'ask')
          throw new Error('Deliberate acceptance failure');
        const step = steps.get(scenario) ?? 0;
        steps.set(scenario, step + 1);
        let content: unknown[] = [{ type: 'text', text: 'Done.' }];
        if (scenario === 'refund-three') {
          const orders = [
            ['ord_01', 25],
            ['ord_02', 49.5],
            ['ord_06', 15],
          ] as const;
          if (step === 0)
            content = orders.map(([id, amount]) => call(id, amount));
          else if (step <= 3) {
            const [id, amount] = orders[step - 1]!;
            content = [call(id, amount)];
          }
        } else if (scenario === 'refund-large') {
          if (!prompt.some((message) => message.role === 'tool'))
            content = [call('ord_08', 200)];
        } else if (scenario === 'refund-wrong-account' && step < 2) {
          content = [call('ord_03', 50, step === 0 ? 'cus_05' : 'cus_03')];
        } else if (scenario === 'email-claim' && step === 0) {
          content = [call('ord_04', 1)];
        } else if (scenario === 'email-claim' && step === 1) {
          content = [
            {
              type: 'tool-call',
              toolCallId: randomUUID(),
              toolName: 'send_email_to_customer',
              input: JSON.stringify({
                customerId: 'cus_03',
                subject: 'Refund',
                body: 'Recorded email.',
              }),
            },
          ];
        }
        return {
          content: content as never,
          finishReason: { unified: 'stop', raw: 'stop' } as const,
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    await seed(connectionString);
    const mcp = await startPlaygroundMcpServer(0);
    const { runtime, db } = await createPlaygroundRuntime({
      connectionString,
      mcpUrl: mcp.url,
      model,
    });
    const worker = runWorker({ runtime, db, pollIdleMs: 20, pollActiveMs: 10 });
    const feed = await startFeedServer(0);
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH,
      headless: true,
    });
    const page = await browser.newPage({
      reducedMotion: 'reduce',
      viewport: { width: 1440, height: 1100 },
    });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    const cases = async () =>
      (
        (await (await fetch(`${feed.url}/api/cases`)).json()) as {
          cases: ReturnType<typeof buildCases>;
        }
      ).cases;
    const invoke = async (scenario: string) => {
      try {
        return (
          await runtime.invoke(
            {
              scope: 'missions-e2e',
              prompt: scenario,
              metadata: { playgroundScenario: scenario },
              maxAttempts: 1,
            },
            { pollIntervalMs: 20, waitTimeoutMs: 30_000 },
          )
        ).invocationId;
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRuntimeError);
        const id = (error as AgentRuntimeError).diagnostics.invocationId;
        expect(typeof id).toBe('string');
        return id as string;
      }
    };
    const select = async (scenario: string, id: string, status: string) => {
      await page.locator(`[data-scenario="${scenario}"]`).click();
      await page.waitForFunction(
        ({ id, status }: { id: string; status: string }) =>
          document.querySelector('#stage-status')?.textContent ===
          `CASE ${id} · ${status}`,
        { id, status },
      );
      expect(
        await page
          .locator(`[data-scenario="${scenario}"]`)
          .getAttribute('aria-pressed'),
      ).toBe('true');
      const item = (await cases()).find(
        (item: { invocationId: string }) => item.invocationId === id,
      )!;
      expect(item.scenario).toBe(scenario);
      expect(
        item.events.every(
          (event: { invocationId: string }) => event.invocationId === id,
        ),
      ).toBe(true);
      await page.waitForFunction(
        (lines: string[]) =>
          JSON.stringify(
            Array.from(document.querySelectorAll('#verdicts li')).map(
              (node) => node.textContent,
            ),
          ) === JSON.stringify(lines),
        item.judge,
      );
      expect(await page.locator('#events li').count()).toBe(item.events.length);
      const evidence = await page.locator('#events li').allTextContents();
      item.events.forEach((event, index) => {
        expect(evidence[index]).toContain(JSON.stringify(event.snapshot));
        expect(evidence[index]).toContain(`· ${event.kind} ·`);
      });
      expect(await page.locator('#orders .order-id').allTextContents()).toEqual(
        item.orders.map((order: { orderId: string }) => order.orderId),
      );
      expect(
        await page.locator('#orders .order-state').allTextContents(),
      ).toEqual(item.orders.map((order: { status: string }) => order.status));
      expect(await page.locator('#record-lines p').count()).toBe(
        item.judge.filter((line: string) => line.startsWith('Executed:'))
          .length,
      );
      return item;
    };
    try {
      const burst = await invoke('refund-three');
      const wrong = await invoke('refund-wrong-account');
      const email = await invoke('email-claim');
      const large = await invoke('refund-large');
      expect((await runtime.getInvocation(large))?.status).toBe(
        'awaiting_approval',
      );
      await page.goto(feed.url);
      await page.locator('#evidence').evaluate((node: HTMLDetailsElement) => {
        node.open = true;
      });
      await select('refund-large', large, 'awaiting_approval');
      expect(await page.locator('#pending-list').textContent()).toContain(
        'ord_08',
      );
      expect(await page.locator('#pending').isVisible()).toBe(true);
      const burstCase = await select('refund-three', burst, 'succeeded');
      expect(burstCase.orders).toHaveLength(3);
      expect(await page.locator('#pending').isVisible()).toBe(false);
      // A genuinely newer failed invocation must not steal a pinned Mission.
      const failed = await invoke('ask');
      expect((await runtime.getInvocation(failed))?.status).toBe('failed');
      await page.waitForFunction(
        (id: string) =>
          document
            .querySelector('[data-scenario="ask"] .mission-status')
            ?.textContent?.includes(`Case ${id}`),
        failed,
      );
      expect(await page.locator('#stage-status').textContent()).toBe(
        `CASE ${burst} · succeeded`,
      );
      const wrongCase = await select(
        'refund-wrong-account',
        wrong,
        'succeeded',
      );
      expect(wrongCase.judge).toContain('Wrong account. Denied before it ran.');
      expect(await page.locator('#denied-stamp').isVisible()).toBe(false);
      await select('email-claim', email, 'succeeded');
      const failedCase = await select('ask', failed, 'failed');
      expect(failedCase.judge.join(' ')).toContain('Case failed:');
      expect(await page.locator('#verdicts .closed').count()).toBe(0);
      await page.locator('#follow').click();
      expect(
        await page
          .locator('[data-scenario="ask"]')
          .getAttribute('aria-pressed'),
      ).toBe('true');
      await select('refund-large', large, 'awaiting_approval');
      await runtime.approveInvocation(large, { resolvedBy: 'missions-e2e' });
      await runtime.waitForInvocation(large, {
        pollIntervalMs: 20,
        waitTimeoutMs: 30_000,
      });
      await select('refund-large', large, 'succeeded');
      expect(await page.locator('#pending').isVisible()).toBe(false);
      await page.locator('[data-scenario="unclassified"]').click();
      expect(await page.locator('#orders .card').count()).toBe(0);
      expect(await page.locator('#events li').count()).toBe(0);
      expect(await page.locator('#record-lines p').count()).toBe(0);
      await select('refund-wrong-account', wrong, 'succeeded');
      if (process.env.MISSION_SCREENSHOT)
        await page.screenshot({
          path: process.env.MISSION_SCREENSHOT,
          fullPage: true,
        });
      expect(errors).toEqual([]);
      console.log(
        'REAL FEED ACCEPTANCE: 5 runtime-created Missions; awaiting_approval -> succeeded; failed; pinned selection; Follow latest; empty selection; Shop/Judge/Record/Evidence synchronized.',
      );
    } finally {
      await browser.close();
      await feed.close();
      await worker.stop();
      await db.close();
      await mcp.close();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      await pg.stop();
    }
  },
  120_000,
);
