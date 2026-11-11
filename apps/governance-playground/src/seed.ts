import { pathToFileURL } from 'node:url';

import { createDb, initDb } from 'runwarden';

import { ensureShopSchema, shopCounts, type ShopCounts } from './shop.js';

const CUSTOMERS = [
  ['cus_01', 'Ada Lopez', 'ada@example.com'],
  ['cus_02', 'Ben Cho', 'ben@example.com'],
  ['cus_03', 'Cy Patel', 'cy@example.com'],
  ['cus_04', 'Dee Nguyen', 'dee@example.com'],
  ['cus_05', 'Eli Brooks', 'eli@example.com'],
  ['cus_06', 'Fay Okonkwo', 'fay@example.com'],
] as const;

const PRODUCTS = [
  ['prd_01', 'Mug', 12],
  ['prd_02', 'Notebook', 18],
  ['prd_03', 'Lamp', 42],
  ['prd_04', 'Keyboard', 79],
  ['prd_05', 'Headphones', 129],
  ['prd_06', 'Monitor', 240],
  ['prd_07', 'Chair', 360],
  ['prd_08', 'Desk', 540],
] as const;

// Amounts sit on both sides of USD 50. ord_07 is already fully refunded.
const ORDERS = [
  ['ord_01', 'cus_01', 'placed', 25],
  ['ord_02', 'cus_02', 'placed', 49.5],
  ['ord_03', 'cus_03', 'placed', 50],
  ['ord_04', 'cus_02', 'shipped', 75],
  ['ord_05', 'cus_03', 'shipped', 120],
  ['ord_06', 'cus_04', 'placed', 15],
  ['ord_07', 'cus_04', 'refunded', 80],
  ['ord_08', 'cus_05', 'shipped', 200],
  ['ord_09', 'cus_05', 'cancelled', 30],
  ['ord_10', 'cus_06', 'placed', 500],
] as const;

const REFUNDS = [['ref_01', 'ord_07', 80]] as const;

export async function seed(databaseUrl: string): Promise<ShopCounts> {
  const handle = createDb(databaseUrl);
  try {
    await initDb(handle);
    await ensureShopSchema(handle.pool);
    await handle.pool.query(
      'truncate sent_emails, refunds, orders, products, customers',
    );
    for (const [id, name, email] of CUSTOMERS) {
      await handle.pool.query(
        'insert into customers (id, name, email) values ($1, $2, $3)',
        [id, name, email],
      );
    }
    for (const [id, name, price] of PRODUCTS) {
      await handle.pool.query(
        'insert into products (id, name, price) values ($1, $2, $3)',
        [id, name, price],
      );
    }
    for (const [id, customerId, status, amount] of ORDERS) {
      await handle.pool.query(
        `insert into orders (id, customer_id, status, amount)
         values ($1, $2, $3, $4)`,
        [id, customerId, status, amount],
      );
    }
    for (const [id, orderId, amount] of REFUNDS) {
      await handle.pool.query(
        'insert into refunds (id, order_id, amount) values ($1, $2, $3)',
        [id, orderId, amount],
      );
    }
    return await shopCounts(handle.pool);
  } finally {
    await handle.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const counts = await seed(databaseUrl);
  console.log(JSON.stringify(counts));
}
