import fs from 'node:fs';
import pg from 'pg';

// int8 (bigint) and numeric come back as strings by default. Every money and unit value here
// fits comfortably in a JS number, so parse them as numbers.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 20 });
}

/** Runs fn inside one transaction; rolls back on any error. */
export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const SEED_PRODUCTS: [string, number, number][] = [
  // name, price in paise, units in stock
  ['Masala Chips', 2000, 20],
  ['Chocolate Bar', 4500, 15],
  ['Cold Coffee', 6000, 10],
  ['Peanut Chikki', 1500, 25],
  ['Mango Juice', 3500, 12],
];

export async function migrate(db: Db): Promise<void> {
  const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await db.query(sql);
}

export async function seedIfEmpty(db: Db): Promise<void> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM products');
  if (rows[0].n > 0) return;
  for (const [name, price, stock] of SEED_PRODUCTS) {
    await db.query('INSERT INTO products (name, price_paise, stock) VALUES ($1, $2, $3)', [name, price, stock]);
  }
}
