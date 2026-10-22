import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, available, resetDb, sendWebhook, sleep, startApp } from './helpers.ts';
import type { Harness } from './helpers.ts';

describe('payment webhook', () => {
  let h: Harness;
  let chips: number;

  before(async () => {
    h = await startApp({ holdSeconds: 2 });
  });
  after(async () => {
    await h.close();
  });
  beforeEach(async () => {
    [chips] = await resetDb(h.db, [['Chips', 2000, 3]]);
  });

  async function order(quantity = 1) {
    const r = await api(h, 'POST', '/orders', { items: [{ productId: chips, quantity }] });
    assert.equal(r.status, 201);
    return r.body as { id: string; totalPaise: number };
  }

  test('the same event sent twice is processed once', async () => {
    const o = await order();
    const event = { eventId: 'evt_dup', orderId: o.id, amountPaise: o.totalPaise, status: 'captured' };

    const first = await sendWebhook(h, event);
    const second = await sendWebhook(h, event);

    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { eventId: 'evt_dup', duplicate: false, outcome: 'paid' });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { eventId: 'evt_dup', duplicate: true, outcome: 'paid' });

    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM payment_events');
    assert.equal(rows[0].n, 1);
    assert.equal((await api(h, 'GET', `/orders/${o.id}`)).body.status, 'paid');
  });

  test('the same event sent twice at the same moment is processed once', async () => {
    const o = await order();
    const event = { eventId: 'evt_race', orderId: o.id, amountPaise: o.totalPaise, status: 'captured' };

    const results = await Promise.all([sendWebhook(h, event), sendWebhook(h, event)]);

    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(results.map((r) => r.body.duplicate).sort(), [false, true]);
    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM payment_events');
    assert.equal(rows[0].n, 1);
  });

  test('a wrong signature is rejected and changes nothing', async () => {
    const o = await order();
    const r = await sendWebhook(h, { eventId: 'evt_bad', orderId: o.id, amountPaise: o.totalPaise, status: 'captured' }, { secret: 'wrong' });
    assert.equal(r.status, 401);
    assert.equal((await api(h, 'GET', `/orders/${o.id}`)).body.status, 'pending');
    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM payment_events');
    assert.equal(rows[0].n, 0);
  });

  test('a missing signature is rejected', async () => {
    const res = await fetch(h.url + '/payments/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'evt_x', orderId: 'x', amountPaise: 1, status: 'captured' }),
    });
    assert.equal(res.status, 401);
  });

  test('an amount that does not match the total marks the order needs_review, not paid, and releases the hold', async () => {
    const o = await order(2);
    const r = await sendWebhook(h, { eventId: 'evt_short', orderId: o.id, amountPaise: o.totalPaise - 1, status: 'captured' });
    assert.equal(r.body.outcome, 'amount_mismatch');
    const after = (await api(h, 'GET', `/orders/${o.id}`)).body;
    assert.equal(after.status, 'needs_review');
    assert.match(after.reviewReason, /order total/);
    assert.equal(await available(h, chips), 3);
  });

  test('a second, different capture for a paid order changes nothing', async () => {
    const o = await order();
    await sendWebhook(h, { eventId: 'evt_1', orderId: o.id, amountPaise: o.totalPaise, status: 'captured' });
    const r = await sendWebhook(h, { eventId: 'evt_2', orderId: o.id, amountPaise: o.totalPaise, status: 'captured' });
    assert.equal(r.body.outcome, 'already_settled');
    assert.equal((await api(h, 'GET', `/orders/${o.id}`)).body.status, 'paid');
  });

  test('a non-captured status is recorded but does not pay the order', async () => {
    const o = await order();
    const r = await sendWebhook(h, { eventId: 'evt_fail', orderId: o.id, amountPaise: o.totalPaise, status: 'failed' });
    assert.equal(r.body.outcome, 'not_captured');
    assert.equal((await api(h, 'GET', `/orders/${o.id}`)).body.status, 'pending');
  });

  test('an event for an unknown order is accepted and recorded, so the provider stops retrying', async () => {
    const r = await sendWebhook(h, { eventId: 'evt_ghost', orderId: '00000000-0000-0000-0000-000000000000', amountPaise: 100, status: 'captured' });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, 'unknown_order');
  });

  test('a late payment is honoured when the units are still free', async () => {
    const o = await order(2);
    await sleep(2300);
    const r = await sendWebhook(h, { eventId: 'evt_late_ok', orderId: o.id, amountPaise: o.totalPaise, status: 'captured' });
    assert.equal(r.body.outcome, 'paid_late');
    assert.equal((await api(h, 'GET', `/orders/${o.id}`)).body.status, 'paid');
    assert.equal(await available(h, chips), 1, 'the paid order holds its 2 units again');
  });

  test('a late payment goes to review when the units were sold to someone else', async () => {
    const late = await order(2);
    await sleep(2300);
    const other = await order(2); // takes 2 of the 3 units after the first hold expired
    const r = await sendWebhook(h, { eventId: 'evt_late_gone', orderId: late.id, amountPaise: late.totalPaise, status: 'captured' });
    assert.equal(r.body.outcome, 'late_no_stock');

    const lateOrder = (await api(h, 'GET', `/orders/${late.id}`)).body;
    assert.equal(lateOrder.status, 'needs_review');
    assert.match(lateOrder.reviewReason, /refund/);
    assert.equal((await api(h, 'GET', `/orders/${other.id}`)).body.status, 'pending', 'the other customer keeps their units');
    assert.equal(await available(h, chips), 1);
  });
});
