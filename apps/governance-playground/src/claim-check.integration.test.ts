// Fake model only; no live provider is used.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import EmbeddedPostgres from 'embedded-postgres';
import { runWorker } from 'runwarden';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { checkClaims, checkRefundThree } from './claim-check.js';
import { startPlaygroundMcpServer } from './mcp-server.js';
import { createPlaygroundRuntime } from './runtime.js';
import { seed } from './seed.js';

let pg: EmbeddedPostgres;
let connectionString: string;
let previousUrl: string | undefined;

beforeAll(async () => {
  const port = 29_000 + Math.floor(Math.random() * 3_000);
  pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpdir(), `gp-claims-${randomUUID()}`),
    user: 'postgres',
    password: 'password',
    port,
    persistent: true,
    postgresFlags: process.platform === 'win32' ? [] : ['-k', tmpdir()],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('gp_claims');
  connectionString = `postgres://postgres:password@localhost:${port}/gp_claims`;
  previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
  await pg?.stop();
});

it.each([false, true])(
  'checks email claim when email sent = %s (fake model)',
  async (sendEmail) => {
    await seed(connectionString);
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const current = step++;
        const content =
          current === 0
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'refund',
                  toolName: 'issue_refund',
                  input: JSON.stringify({ orderId: 'ord_03', amount: 50 }),
                },
              ]
            : current === 1 && sendEmail
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: 'email',
                    toolName: 'send_email_to_customer',
                    input: JSON.stringify({
                      customerId: 'cus_03',
                      subject: 'Refund',
                      body: 'Done',
                    }),
                  },
                ]
              : [
                  {
                    type: 'text',
                    text: 'The refund is complete and the email was sent.',
                  },
                ];
        return {
          content: content as never,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
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
    const mcp = await startPlaygroundMcpServer(0);
    const { runtime, db } = await createPlaygroundRuntime({
      connectionString,
      mcpUrl: mcp.url,
      model,
    });
    const worker = runWorker({ runtime, db, pollIdleMs: 20, pollActiveMs: 10 });
    try {
      const result = await runtime.invoke(
        {
          scope: 'playground-demo',
          prompt: 'Refund and email',
          maxAttempts: 1,
        },
        { pollIntervalMs: 20, waitTimeoutMs: 30_000 },
      );
      const claims = await checkClaims(db, result.invocationId, result.text);
      expect(claims).toEqual([
        expect.objectContaining({ claim: 'refund', verified: true }),
        expect.objectContaining({ claim: 'email', verified: sendEmail }),
      ]);
      if (!sendEmail)
        expect(claims[1]?.evidence).toContain(
          'no succeeded send_email_to_customer audit',
        );
      const emails = await db.pool.query('select id from sent_emails');
      expect(emails.rowCount).toBe(sendEmail ? 1 : 0);
      if (sendEmail) {
        await db.pool.query('delete from sent_emails');
        expect(
          await checkClaims(db, result.invocationId, 'Email sent.'),
        ).toEqual([
          expect.objectContaining({
            claim: 'email',
            verified: false,
            evidence: expect.stringContaining('no matching sent_emails row'),
          }),
        ]);
      }
      expect(await checkClaims(db, result.invocationId, 'Done.')).toEqual([]);
      expect(await checkRefundThree(db, result.invocationId)).toMatchObject({
        verified: false,
        evidence: expect.stringContaining('ord_01 $25.00'),
      });
    } finally {
      await worker.stop();
      await db.close();
      await mcp.close();
    }
  },
);
