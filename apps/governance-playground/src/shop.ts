import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import type { z } from 'zod';

import {
  cancelOrderInput,
  deleteCustomerInput,
  getCustomerInput,
  getOrderInput,
  issueRefundInput,
  listOrdersInput,
  sendEmailToCustomerInput,
} from './tools.js';

// Sandbox tables stay in public. Do not touch agent_runtime.
const SHOP_DDL = `
create table if not exists customers (
  id text primary key,
  name text not null,
  email text not null
);
create table if not exists products (
  id text primary key,
  name text not null,
  price numeric(12,2) not null
);
create table if not exists orders (
  id text primary key,
  customer_id text not null,
  status text not null,
  amount numeric(12,2) not null
);
create table if not exists refunds (
  id text primary key,
  order_id text not null,
  amount numeric(12,2) not null
);
alter table refunds add column if not exists destination_customer_id text;
create table if not exists sent_emails (
  id text primary key,
  customer_id text not null,
  subject text not null,
  body text not null
);
`;

export interface ShopOrder {
  id: string;
  customerId: string;
  status: string;
  amount: number;
}

export interface ShopCustomer {
  id: string;
  name: string;
  email: string;
}

export interface ShopProduct {
  id: string;
  name: string;
  price: number;
}

export interface ShopCounts {
  customers: number;
  products: number;
  orders: number;
  refunds: number;
  sent_emails: number;
}

const COUNT_TABLES = [
  'customers',
  'products',
  'orders',
  'refunds',
  'sent_emails',
] as const satisfies ReadonlyArray<keyof ShopCounts>;

export async function ensureShopSchema(pool: Pool): Promise<void> {
  await pool.query(SHOP_DDL);
}

export async function shopCounts(pool: Pool): Promise<ShopCounts> {
  const counts = {} as ShopCounts;
  for (const table of COUNT_TABLES) {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from ${table}`,
    );
    counts[table] = rows[0]?.n ?? 0;
  }
  return counts;
}

export async function listOrders(
  pool: Pool,
  input: zInput<typeof listOrdersInput> = {},
): Promise<ShopOrder[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (input.customerId) {
    params.push(input.customerId);
    where.push(`customer_id = $${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status = $${params.length}`);
  }
  const { rows } = await pool.query<{
    id: string;
    customer_id: string;
    status: string;
    amount: string;
  }>(
    `select id, customer_id, status, amount::text as amount
     from orders${where.length ? ` where ${where.join(' and ')}` : ''}
     order by id`,
    params,
  );
  return rows.map(orderFrom);
}

export async function getOrder(
  pool: Pool,
  input: zInput<typeof getOrderInput>,
): Promise<ShopOrder | null> {
  const { rows } = await pool.query<{
    id: string;
    customer_id: string;
    status: string;
    amount: string;
  }>(
    `select id, customer_id, status, amount::text as amount
     from orders where id = $1`,
    [input.orderId],
  );
  return rows[0] ? orderFrom(rows[0]) : null;
}

export async function listCustomers(pool: Pool): Promise<ShopCustomer[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    email: string;
  }>('select id, name, email from customers order by id');
  return rows;
}

export async function getCustomer(
  pool: Pool,
  input: zInput<typeof getCustomerInput>,
): Promise<ShopCustomer | null> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    email: string;
  }>('select id, name, email from customers where id = $1', [input.customerId]);
  return rows[0] ?? null;
}

export async function listProducts(pool: Pool): Promise<ShopProduct[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    price: string;
  }>('select id, name, price::text as price from products order by id');
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    price: Number(row.price),
  }));
}

export async function issueRefund(
  pool: Pool,
  input: zInput<typeof issueRefundInput>,
): Promise<{ id: string; orderId: string; amount: number; status: string }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    try {
      const locked = await client.query<{ status: string }>(
        'select status from orders where id = $1 for update',
        [input.orderId],
      );
      if (!locked.rows[0]) throw new Error(`order not found: ${input.orderId}`);
      const verdict = await client.query<{ reason: string | null }>(
        `select case
           when status = 'cancelled' then 'cannot refund a cancelled order'
           when $2::numeric <= 0 then 'amount must be positive'
           when $2::numeric > amount then 'amount exceeds order amount'
           when coalesce((select sum(amount) from refunds where order_id = orders.id), 0) >= amount
             then 'order is fully refunded'
           when $2::numeric > amount - coalesce((select sum(amount) from refunds where order_id = orders.id), 0)
             then 'amount exceeds remaining refundable amount'
           else null
         end as reason
         from orders
         where id = $1`,
        [input.orderId, input.amount],
      );
      const reason = verdict.rows[0]?.reason;
      if (reason) throw new Error(reason);

      const id = `ref_${randomUUID()}`;
      await client.query(
        `insert into refunds (id, order_id, amount, destination_customer_id)
         select $1, id, $3, coalesce($4, customer_id) from orders where id = $2`,
        [id, input.orderId, input.amount, input.destinationCustomerId ?? null],
      );
      const updated = await client.query<{ status: string }>(
        `update orders
         set status = 'refunded'
         where id = $1
           and (
             select coalesce(sum(amount), 0) from refunds where order_id = $1
           ) >= amount
         returning status`,
        [input.orderId],
      );
      await client.query('commit');
      return {
        id,
        orderId: input.orderId,
        amount: input.amount,
        status: updated.rows[0]?.status ?? locked.rows[0].status,
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function cancelOrder(
  pool: Pool,
  input: zInput<typeof cancelOrderInput>,
): Promise<{ id: string; status: 'cancelled' }> {
  const existing = await getOrder(pool, input);
  if (!existing) throw new Error(`order not found: ${input.orderId}`);
  if (existing.status === 'shipped' || existing.status === 'refunded') {
    throw new Error(`cannot cancel order in status ${existing.status}`);
  }
  await pool.query(`update orders set status = 'cancelled' where id = $1`, [
    input.orderId,
  ]);
  return { id: input.orderId, status: 'cancelled' };
}

export async function deleteCustomer(
  pool: Pool,
  input: zInput<typeof deleteCustomerInput>,
): Promise<{ id: string }> {
  const { rowCount } = await pool.query('delete from customers where id = $1', [
    input.customerId,
  ]);
  if (!rowCount) throw new Error(`customer not found: ${input.customerId}`);
  return { id: input.customerId };
}

export async function sendEmailToCustomer(
  pool: Pool,
  input: zInput<typeof sendEmailToCustomerInput>,
): Promise<{ id: string }> {
  const customer = await getCustomer(pool, {
    customerId: input.customerId,
  });
  if (!customer) throw new Error(`customer not found: ${input.customerId}`);
  const id = `em_${randomUUID()}`;
  await pool.query(
    `insert into sent_emails (id, customer_id, subject, body)
     values ($1, $2, $3, $4)`,
    [id, input.customerId, input.subject, input.body],
  );
  return { id };
}

type zInput<T extends z.ZodType> = z.infer<T>;

function orderFrom(row: {
  id: string;
  customer_id: string;
  status: string;
  amount: string;
}): ShopOrder {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    amount: Number(row.amount),
  };
}
