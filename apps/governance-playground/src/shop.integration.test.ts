import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { createDb, type DatabaseHandle } from 'runwarden';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cancelOrder,
  deleteCustomer,
  getOrder,
  issueRefund,
  sendEmailToCustomer,
  shopCounts,
} from './shop.js';
import { seed } from './seed.js';
import { tools } from './tools.js';

describe('governance playground shop', () => {
  let connectionString: string;
  let handle: DatabaseHandle;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const pg = await startTestPostgres();
    connectionString = pg.connectionString;
    stop = pg.stop;
    handle = createDb(connectionString);
  });

  afterAll(async () => {
    await handle?.close();
    await stop?.();
  });

  beforeEach(async () => {
    await seed(connectionString);
  });

  it('exports the nine sandbox tools', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_orders',
      'get_order',
      'list_customers',
      'get_customer',
      'list_products',
      'issue_refund',
      'send_email_to_customer',
      'cancel_order',
      'delete_customer',
    ]);
  });

  it('keeps row counts when seed runs twice', async () => {
    const first = await seed(connectionString);
    const second = await seed(connectionString);
    expect(second).toEqual(first);
    expect(first).toEqual({
      customers: 6,
      products: 8,
      orders: 10,
      refunds: 1,
      sent_emails: 0,
    });
  });

  it('rejects a refund above the order amount or the remaining balance', async () => {
    const pool = handle.pool;
    await expect(
      issueRefund(pool, { orderId: 'ord_01', amount: 25.01 }),
    ).rejects.toThrow(/exceeds order amount/);
    await issueRefund(pool, { orderId: 'ord_01', amount: 20 });
    await expect(
      issueRefund(pool, { orderId: 'ord_01', amount: 10 }),
    ).rejects.toThrow(/remaining refundable amount/);
    expect(await refundCount(pool, 'ord_01')).toBe(1);
    await expect(
      issueRefund(pool, { orderId: 'ord_07', amount: 1 }),
    ).rejects.toThrow(/fully refunded/);
    expect(await refundCount(pool, 'ord_07')).toBe(1);
  });

  it('rejects a refund for a cancelled order', async () => {
    await expect(
      issueRefund(handle.pool, { orderId: 'ord_09', amount: 30 }),
    ).rejects.toThrow(/cancelled/);
    expect(await refundCount(handle.pool, 'ord_09')).toBe(0);
  });

  it('marks the order refunded when cumulative refunds reach the amount', async () => {
    const pool = handle.pool;
    const partial = await issueRefund(pool, { orderId: 'ord_01', amount: 10 });
    expect(partial.status).toBe('placed');
    expect((await getOrder(pool, { orderId: 'ord_01' }))?.status).toBe(
      'placed',
    );
    const full = await issueRefund(pool, { orderId: 'ord_01', amount: 15 });
    expect(full.status).toBe('refunded');
    expect((await getOrder(pool, { orderId: 'ord_01' }))?.status).toBe(
      'refunded',
    );
    expect(await refundCount(pool, 'ord_01')).toBe(2);
  });

  it('cancels only orders that are not shipped or refunded', async () => {
    const pool = handle.pool;
    await expect(cancelOrder(pool, { orderId: 'ord_04' })).rejects.toThrow(
      /shipped/,
    );
    await expect(cancelOrder(pool, { orderId: 'ord_07' })).rejects.toThrow(
      /refunded/,
    );
    expect((await getOrder(pool, { orderId: 'ord_04' }))?.status).toBe(
      'shipped',
    );
    await cancelOrder(pool, { orderId: 'ord_01' });
    expect((await getOrder(pool, { orderId: 'ord_01' }))?.status).toBe(
      'cancelled',
    );
  });

  it('deletes one customer row', async () => {
    const before = await shopCounts(handle.pool);
    await deleteCustomer(handle.pool, { customerId: 'cus_06' });
    const after = await shopCounts(handle.pool);
    expect(after.customers).toBe(before.customers - 1);
    expect(after.orders).toBe(before.orders);
  });

  it('records one sent email and does not send mail', async () => {
    const before = await shopCounts(handle.pool);
    await sendEmailToCustomer(handle.pool, {
      customerId: 'cus_01',
      subject: 'Order update',
      body: 'Your mug is packed.',
    });
    const after = await shopCounts(handle.pool);
    expect(after.sent_emails).toBe(before.sent_emails + 1);
    const { rows } = await handle.pool.query(
      'select customer_id, subject, body from sent_emails',
    );
    expect(rows).toEqual([
      {
        customer_id: 'cus_01',
        subject: 'Order update',
        body: 'Your mug is packed.',
      },
    ]);
  });
});

async function refundCount(pool: Pool, orderId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'select count(*)::int as n from refunds where order_id = $1',
    [orderId],
  );
  return rows[0]?.n ?? 0;
}

async function startTestPostgres(): Promise<{
  connectionString: string;
  stop(): Promise<void>;
}> {
  const port = 25_000 + Math.floor(Math.random() * 4_000);
  const databaseName = 'gp_test';
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpdir(), `gp-pg-${randomUUID()}`),
    user: 'postgres',
    password: 'password',
    port,
    persistent: true,
    postgresFlags: process.platform === 'win32' ? [] : ['-k', tmpdir()],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(databaseName);
  return {
    connectionString: `postgres://postgres:password@localhost:${port}/${databaseName}`,
    stop: () => pg.stop(),
  };
}
