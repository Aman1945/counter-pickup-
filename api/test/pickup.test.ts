import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, available, resetDb, sendWebhook, sleep, startApp } from './helpers.ts';
import type { Harness } from './helpers.ts';

describe('pickup', () => {
  let h: Harness;
  let chips: number;

  before(async () => {
    h = await startApp({ holdSeconds: 2 });
  });
  after(async () => {
    await h.close();
  });
  beforeEach(async () => {
    [chips] = await resetDb(h.db, [['Chips', 2000, 5]]);
  });

  async function paidOrder(quantity: number) {
    const o = (await api(h, 'POST', '/orders', { items: [{ productId: chips, quantity }] })).body;
    const r = await sendWebhook(h, { eventId: `evt_${o.id}`, orderId: o.id, amountPaise: o.totalPaise, status: 'captured' });
    assert.equal(r.body.outcome, 'paid');
    return o as { id: string };
  }

  async function stock(): Promise<number> {
    const { rows } = await h.db.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [chips]);
    return rows[0].stock;
  }

  test('two simultaneous pickup claims: exactly one succeeds, the other gets 409', async () => {
    const o = await paidOrder(2);

    const results = await Promise.all([api(h, 'POST', `/orders/${o.id}/pickup-claim`), api(h, 'POST', `/orders/${o.id}/pickup-claim`)]);

    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    assert.equal(winner.body.status, 'picked_up');
    // Stock went down exactly once, permanently; availability is unchanged by the handover.
    assert.equal(await stock(), 3);
    assert.equal(await available(h, chips), 3);
  });

  test('ten lockers claiming at once: still exactly one success', async () => {
    const o = await paidOrder(1);
    const results = await Promise.all(Array.from({ length: 10 }, () => api(h, 'POST', `/orders/${o.id}/pickup-claim`)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 9);
    assert.equal(await stock(), 4);
  });

  test('an unpaid order cannot be claimed', async () => {
    const o = (await api(h, 'POST', '/orders', { items: [{ productId: chips, quantity: 1 }] })).body;
    const r = await api(h, 'POST', `/orders/${o.id}/pickup-claim`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.details.status, 'pending');
    assert.equal(await stock(), 5);
  });

  test('an expired order cannot be claimed', async () => {
    const o = (await api(h, 'POST', '/orders', { items: [{ productId: chips, quantity: 1 }] })).body;
    await sleep(2300);
    const r = await api(h, 'POST', `/orders/${o.id}/pickup-claim`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.details.status, 'expired');
  });

  test('an unknown order gets 404', async () => {
    assert.equal((await api(h, 'POST', '/orders/00000000-0000-0000-0000-000000000000/pickup-claim')).status, 404);
  });
});
