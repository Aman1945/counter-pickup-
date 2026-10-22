import type { Db, Tx } from './db.ts';

/**
 * Units an order holds while it is in one of these states. One definition, used by every query,
 * so "available" means the same thing everywhere:
 *   - pending and not yet expired: the 120 s hold
 *   - paid: the customer owns the units, they are still in the counter until pickup
 * The expiry check uses the database clock, so correctness never depends on a background job.
 */
export const HOLDING_ORDER = `(o.status = 'pending' AND o.expires_at > now()) OR o.status = 'paid'`;

/** Units of a product currently held by orders, as a SQL expression over `p`. */
const HELD_UNITS = `COALESCE((
  SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.product_id = p.id AND (${HOLDING_ORDER})
), 0)`;

export type ProductRow = { id: number; name: string; pricePaise: number; stock: number; available: number };

export async function listProducts(db: Db | Tx): Promise<ProductRow[]> {
  const { rows } = await db.query<ProductRow>(
    `SELECT p.id, p.name, p.price_paise AS "pricePaise", p.stock,
            p.stock - ${HELD_UNITS} AS available
     FROM products p ORDER BY p.id`,
  );
  return rows;
}

/**
 * Locks the given product rows (in id order, so two transactions never wait on each other in a
 * cycle) and returns their price and available units. Callers that want to take units must call
 * this first inside their transaction: the row lock is what serialises competing buyers.
 */
export async function lockProducts(tx: Tx, productIds: number[]): Promise<Map<number, ProductRow>> {
  const ids = [...productIds].sort((a, b) => a - b);
  await tx.query('SELECT id FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
  // Read availability after the locks are held: this statement sees every hold committed before us.
  const { rows } = await tx.query<ProductRow>(
    `SELECT p.id, p.name, p.price_paise AS "pricePaise", p.stock,
            p.stock - ${HELD_UNITS} AS available
     FROM products p WHERE p.id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}
