// Test harness: a real PostgreSQL database and the real HTTP app on a random port. No mocks.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { createPool, migrate } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { sign } from '../src/payments.ts';

export const SECRET = 'test-secret';
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://pickup:pickup@localhost:5433/pickup_test';

export type Harness = { db: Db; url: string; close: () => Promise<void> };

export async function startApp(opts: { holdSeconds?: number } = {}): Promise<Harness> {
  const db = createPool(DATABASE_URL);
  await migrate(db);
  const app = createApp({ db, webhookSecret: SECRET, holdSeconds: opts.holdSeconds ?? 120 });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    db,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((r) => server.close(r));
      await db.end();
    },
  };
}

/** Empties every table and inserts the given products. Returns their ids in order. */
export async function resetDb(db: Db, products: [string, number, number][]): Promise<number[]> {
  await db.query('TRUNCATE payment_events, order_items, orders, products RESTART IDENTITY CASCADE');
  const ids: number[] = [];
  for (const [name, price, stock] of products) {
    const { rows } = await db.query<{ id: number }>('INSERT INTO products (name, price_paise, stock) VALUES ($1, $2, $3) RETURNING id', [name, price, stock]);
    ids.push(rows[0].id);
  }
  return ids;
}

export async function api(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(h.url + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

export async function sendWebhook(h: Harness, event: object, opts: { secret?: string } = {}): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(event);
  const res = await fetch(h.url + '/payments/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sign(raw, opts.secret ?? SECRET) },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

export async function available(h: Harness, productId: number): Promise<number> {
  const r = await api(h, 'GET', '/products');
  return r.body.products.find((p: { id: number }) => p.id === productId).available;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
