import { inTx } from './db.ts';
import type { Db, Tx } from './db.ts';
import { AppError } from './errors.ts';
import { lockProducts } from './stock.ts';

export type OrderStatus = 'pending' | 'paid' | 'picked_up' | 'expired' | 'needs_review';

export type OrderView = {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  expiresAt: string;
  expiresInSeconds: number;
  reviewReason: string | null;
  items: { productId: number; name: string; quantity: number; unitPricePaise: number }[];
};

const MAX_UNITS_PER_LINE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOrderId(id: string): boolean {
  return UUID.test(id);
}

/** Validates the request body and merges repeated products into one line each. */
export function parseOrderItems(body: unknown): Map<number, number> {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, 'invalid_request', 'Body must be { "items": [{ "productId": number, "quantity": number }, ...] } with at least one item');
  }
  const lines = new Map<number, number>();
  for (const it of items) {
    const productId = (it as { productId?: unknown })?.productId;
    const quantity = (it as { quantity?: unknown })?.quantity;
    if (!Number.isSafeInteger(productId) || (productId as number) <= 0) {
      throw new AppError(400, 'invalid_request', 'productId must be a positive integer');
    }
    if (!Number.isSafeInteger(quantity) || (quantity as number) <= 0) {
      throw new AppError(400, 'invalid_request', 'quantity must be a positive integer');
    }
    const next = (lines.get(productId as number) ?? 0) + (quantity as number);
    if (next > MAX_UNITS_PER_LINE) throw new AppError(400, 'invalid_request', `At most ${MAX_UNITS_PER_LINE} units of one product per order`);
    lines.set(productId as number, next);
  }
  return lines;
}

/**
 * Creates a pending order and holds its units for holdSeconds.
 * All-or-nothing: if any line lacks stock, the transaction rolls back and nothing is held.
 */
export async function createOrder(db: Db, lines: Map<number, number>, holdSeconds: number): Promise<OrderView> {
  const orderId = await inTx(db, async (tx) => {
    const products = await lockProducts(tx, [...lines.keys()]);

    const missing = [...lines.keys()].filter((id) => !products.has(id));
    if (missing.length) throw new AppError(404, 'product_not_found', `Unknown product id(s): ${missing.join(', ')}`, { productIds: missing });

    const short = [...lines].filter(([id, qty]) => products.get(id)!.available < qty);
    if (short.length) {
      throw new AppError(409, 'insufficient_stock', 'Not enough stock for one or more items; nothing was held', {
        items: short.map(([id, qty]) => ({ productId: id, requested: qty, available: Math.max(0, products.get(id)!.available) })),
      });
    }

    let total = 0;
    for (const [id, qty] of lines) total += products.get(id)!.pricePaise * qty;

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO orders (status, total_paise, expires_at)
       VALUES ('pending', $1, now() + make_interval(secs => $2)) RETURNING id`,
      [total, holdSeconds],
    );
    for (const [id, qty] of lines) {
      await tx.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price_paise) VALUES ($1, $2, $3, $4)', [
        rows[0].id,
        id,
        qty,
        products.get(id)!.pricePaise,
      ]);
    }
    return rows[0].id;
  });
  return (await getOrder(db, orderId))!;
}

/** Marks every pending order whose hold has run out as expired. Display only: holds already ignore them. */
export async function expireDueOrders(db: Db | Tx, orderId?: string): Promise<number> {
  const r = await db.query(
    `UPDATE orders SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= now() AND ($1::uuid IS NULL OR id = $1::uuid)`,
    [orderId ?? null],
  );
  return r.rowCount ?? 0;
}

export async function getOrder(db: Db, orderId: string): Promise<OrderView | null> {
  if (!isOrderId(orderId)) return null;
  await expireDueOrders(db, orderId);
  const { rows } = await db.query<{
    id: string;
    status: OrderStatus;
    total_paise: number;
    expires_at: Date;
    ms_left: number;
    review_reason: string | null;
  }>(
    // ms_left uses the same clock that set expires_at (the database), so the two can never disagree.
    `SELECT id, status, total_paise, expires_at, review_reason,
            EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000 AS ms_left
     FROM orders WHERE id = $1`,
    [orderId],
  );
  if (!rows.length) return null;
  const o = rows[0];
  const items = await db.query<{ productId: number; name: string; quantity: number; unitPricePaise: number }>(
    `SELECT oi.product_id AS "productId", p.name, oi.quantity, oi.unit_price_paise AS "unitPricePaise"
     FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.product_id`,
    [orderId],
  );
  return {
    id: o.id,
    status: o.status,
    totalPaise: o.total_paise,
    expiresAt: o.expires_at.toISOString(),
    expiresInSeconds: secondsLeft(o.status, o.ms_left),
    reviewReason: o.review_reason,
    items: items.rows,
  };
}

/**
 * Seconds left on the hold, read from the server clock just before the response is sent.
 * The screen counts down from this number, never from its own clock.
 */
export function secondsLeft(status: OrderStatus, msLeft: number): number {
  if (status !== 'pending') return 0;
  return Math.max(0, Math.ceil(msLeft / 1000));
}

/**
 * The locker hands the order over. The conditional UPDATE is the whole concurrency story: two
 * lockers race for the same row, Postgres makes the second wait for the first, then re-checks
 * `status = 'paid'`, finds 'picked_up', and updates nothing. Exactly one call wins.
 */
export async function claimPickup(db: Db, orderId: string): Promise<OrderView> {
  if (!isOrderId(orderId)) throw new AppError(404, 'order_not_found', 'Order not found');
  await inTx(db, async (tx: Tx) => {
    await expireDueOrders(tx, orderId); // so a stale 'pending' is reported as 'expired'
    const won = await tx.query(
      `UPDATE orders SET status = 'picked_up', picked_up_at = now() WHERE id = $1 AND status = 'paid' RETURNING id`,
      [orderId],
    );
    if (won.rowCount === 0) {
      const { rows } = await tx.query<{ status: OrderStatus }>('SELECT status FROM orders WHERE id = $1', [orderId]);
      if (!rows.length) throw new AppError(404, 'order_not_found', 'Order not found');
      const reason: Record<OrderStatus, string> = {
        picked_up: 'This order has already been picked up',
        pending: 'This order has not been paid',
        expired: 'This order expired without payment',
        needs_review: 'This order is waiting for a payment review',
        paid: 'This order could not be claimed',
      };
      throw new AppError(409, 'cannot_claim', reason[rows[0].status], { status: rows[0].status });
    }
    // The units leave the counter for good. The CHECK (stock >= 0) is a last line of defence.
    await tx.query(
      `UPDATE products p SET stock = p.stock - oi.quantity
       FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = p.id`,
      [orderId],
    );
  });
  return (await getOrder(db, orderId))!;
}
