import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, available, resetDb, sleep, startApp } from './helpers.ts';
import type { Harness } from './helpers.ts';

describe('placing orders', () => {
  let h: Harness;
  let chips: number;
  let coffee: number;

  before(async () => {
    h = await startApp({ holdSeconds: 2 });
  });
  after(async () => {
    await h.close();
  });
  beforeEach(async () => {
    [chips, coffee] = await resetDb(h.db, [
      ['Chips', 2000, 2],
      ['Coffee', 6000, 10],
    ]);
  });

  test('ten customers ordering the last two units at the same moment: exactly two are held, the rest fail cleanly', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api(h, 'POST', '/orders', { items: [{ productId: chips, quantity: 1 }] })),
    );

    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    assert.equal(created.length, 2);
    assert.equal(refused.length, 8);
    for (const r of refused) assert.equal(r.body.error.code, 'insufficient_stock');

    // Exactly two units held, none left, and the refused requests left nothing behind.
    assert.equal(await available(h, chips), 0);
    const { rows } = await h.db.query<{ orders: number; held: number }>(
      `SELECT count(DISTINCT o.id)::int AS orders, COALESCE(SUM(oi.quantity), 0)::int AS held
       FROM orders o JOIN order_items oi ON oi.order_id = o.id`,
    );
    assert.deepEqual(rows[0], { orders: 2, held: 2 });
  });

  test('an order that cannot be fully met holds nothing at all', async () => {
    const r = await api(h, 'POST', '/orders', {
      items: [
        { productId: coffee, quantity: 1 },
        { productId: chips, quantity: 3 },
      ],
    });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.error.details.items, [{ productId: chips, requested: 3, available: 2 }]);
    assert.equal(await available(h, coffee), 10, 'the coffee line must not stay held');
  });

  test('total is computed in paise, repeated products are merged, and expiresInSeconds counts down from the hold', async () => {
    const r = await api(h, 'POST', '/orders', {
      items: [
        { productId: coffee, quantity: 1 },
        { productId: chips, quantity: 1 },
        { productId: coffee, quantity: 2 },
      ],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'pending');
    assert.equal(r.body.totalPaise, 3 * 6000 + 2000);
    assert.equal(r.body.items.length, 2);
    assert.ok(r.body.expiresInSeconds > 0 && r.body.expiresInSeconds <= 2);
    assert.equal(await available(h, coffee), 7);
  });

  test('when the hold runs out the units come back and the order shows expired', async () => {
    const r = await api(h, 'POST', '/orders', { items: [{ productId: chips, quantity: 2 }] });
    assert.equal(r.status, 201);
    assert.equal(await available(h, chips), 0);

    await sleep(2300);

    assert.equal(await available(h, chips), 2);
    const later = await api(h, 'GET', `/orders/${r.body.id}`);
    assert.equal(later.body.status, 'expired');
    assert.equal(later.body.expiresInSeconds, 0);
  });

  test('bad input is rejected with 400, unknown products with 404', async () => {
    assert.equal((await api(h, 'POST', '/orders', { items: [] })).status, 400);
    assert.equal((await api(h, 'POST', '/orders', { items: [{ productId: chips, quantity: 0 }] })).status, 400);
    assert.equal((await api(h, 'POST', '/orders', { items: [{ productId: chips, quantity: 1.5 }] })).status, 400);
    assert.equal((await api(h, 'POST', '/orders', { items: [{ productId: 999, quantity: 1 }] })).status, 404);
    assert.equal((await api(h, 'GET', '/orders/not-a-uuid')).status, 404);
  });
});
