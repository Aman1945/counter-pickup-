import crypto from 'node:crypto';
import { inTx } from './db.ts';
import type { Db, Tx } from './db.ts';
import { AppError } from './errors.ts';
import { isOrderId } from './orders.ts';
import type { OrderStatus } from './orders.ts';
import { lockProducts } from './stock.ts';

export type WebhookEvent = { eventId: string; orderId: string; amountPaise: number; status: string };

export type WebhookResult = { eventId: string; duplicate: boolean; outcome: string };

export function sign(rawBody: Buffer | string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Constant-time comparison of the X-Signature header with the HMAC of the exact bytes received. */
export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = Buffer.from(sign(rawBody, secret), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(header, 'hex'));
}

export function parseEvent(rawBody: Buffer): WebhookEvent {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new AppError(400, 'invalid_json', 'Body is not valid JSON');
  }
  const { eventId, orderId, amountPaise, status } = body ?? {};
  if (typeof eventId !== 'string' || !eventId) throw new AppError(400, 'invalid_event', 'eventId must be a non-empty string');
  if (typeof orderId !== 'string') throw new AppError(400, 'invalid_event', 'orderId must be a string');
  if (!Number.isSafeInteger(amountPaise) || (amountPaise as number) < 0) throw new AppError(400, 'invalid_event', 'amountPaise must be a non-negative integer');
  if (typeof status !== 'string') throw new AppError(400, 'invalid_event', 'status must be a string');
  return { eventId, orderId, amountPaise: amountPaise as number, status };
}

/**
 * Applies one provider event, exactly once.
 *
 * Idempotency: the event row is inserted first with ON CONFLICT DO NOTHING, in the same transaction
 * as the order change. A repeated event finds the row already there and changes nothing. Two copies
 * arriving at the same moment both try the insert; the second waits on the first's primary-key
 * entry and then sees the conflict.
 *
 * Outcomes (stored on the event row):
 *   paid               captured, amount matches, hold still running
 *   paid_late          captured after the hold expired, and the units were still free: re-held as paid
 *   late_no_stock      captured after the hold expired, units gone: needs_review (refund)
 *   amount_mismatch    amount differs from the order total: needs_review
 *   already_settled    a second, different capture for an order already paid/picked up: no change (refund)
 *   not_captured       status other than "captured": recorded, no change
 *   unknown_order      no such order: recorded, no change
 */
export async function applyWebhook(db: Db, ev: WebhookEvent): Promise<WebhookResult> {
  return inTx(db, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO payment_events (event_id, order_id, amount_paise, status)
       VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [ev.eventId, ev.orderId, ev.amountPaise, ev.status],
    );
    if (inserted.rowCount === 0) {
      const prev = await tx.query<{ outcome: string }>('SELECT outcome FROM payment_events WHERE event_id = $1', [ev.eventId]);
      return { eventId: ev.eventId, duplicate: true, outcome: prev.rows[0]?.outcome ?? 'unknown' };
    }

    const outcome = await decide(tx, ev);
    await tx.query('UPDATE payment_events SET outcome = $2 WHERE event_id = $1', [ev.eventId, outcome]);
    return { eventId: ev.eventId, duplicate: false, outcome };
  });
}

async function decide(tx: Tx, ev: WebhookEvent): Promise<string> {
  if (!isOrderId(ev.orderId)) return 'unknown_order';
  // Lock the order row: a concurrent pickup or a second event for this order waits for us.
  const { rows } = await tx.query<{ status: OrderStatus; total_paise: number; still_held: boolean }>(
    `SELECT status, total_paise, (status = 'pending' AND expires_at > now()) AS still_held
     FROM orders WHERE id = $1 FOR UPDATE`,
    [ev.orderId],
  );
  if (!rows.length) return 'unknown_order';
  const order = rows[0];

  if (ev.status !== 'captured') return 'not_captured';
  if (order.status === 'paid' || order.status === 'picked_up') return 'already_settled';
  if (order.status === 'needs_review') return 'already_in_review';

  if (ev.amountPaise !== order.total_paise) {
    await markReview(tx, ev.orderId, `Paid ${ev.amountPaise} paise, order total is ${order.total_paise} paise`);
    return 'amount_mismatch';
  }

  if (order.still_held) {
    await tx.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [ev.orderId]);
    return 'paid';
  }

  // Late payment: the hold ran out (status 'expired', or 'pending' not yet swept).
  // Honour it if the units are still free right now; otherwise send it to review for a refund.
  const items = await tx.query<{ product_id: number; quantity: number }>(
    'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
    [ev.orderId],
  );
  const products = await lockProducts(tx, items.rows.map((i) => i.product_id));
  const enough = items.rows.every((i) => (products.get(i.product_id)?.available ?? 0) >= i.quantity);
  if (enough) {
    await tx.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [ev.orderId]);
    return 'paid_late';
  }
  await markReview(tx, ev.orderId, 'Payment arrived after the hold expired and the items are no longer available; refund needed');
  return 'late_no_stock';
}

async function markReview(tx: Tx, orderId: string, reason: string): Promise<void> {
  await tx.query(`UPDATE orders SET status = 'needs_review', review_reason = $2 WHERE id = $1`, [orderId, reason]);
}
