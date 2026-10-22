import { useCallback, useEffect, useState } from 'react';
import { ApiError, getOrder, getProducts, placeOrder, rupees } from './api.ts';
import type { Order, Product } from './api.ts';
import { deadlineFrom, useSecondsLeft } from './countdown.ts';

const POLL_MS = 2000;

export default function App() {
  const [order, setOrder] = useState<Order | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);

  // Every server response (the order itself, then each poll) resets the deadline.
  const onOrder = useCallback((o: Order) => {
    setOrder(o);
    setDeadline(deadlineFrom(o.expiresInSeconds));
  }, []);

  return (
    <main>
      <h1>Pickup Counter</h1>
      {order ? (
        <Payment
          order={order}
          deadline={deadline}
          onUpdate={onOrder}
          onDone={() => {
            setOrder(null);
            setDeadline(null);
          }}
        />
      ) : (
        <Catalog onPlaced={onOrder} />
      )}
    </main>
  );
}

function Catalog({ onPlaced }: { onPlaced: (o: Order) => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getProducts()
      .then(setProducts)
      .catch(() => setError('Could not load products. Is the server running?'));
  }, []);
  useEffect(load, [load]);

  const qty = (id: number) => cart[id] ?? 0;
  const change = (p: Product, delta: number) => {
    const next = Math.min(Math.max(0, qty(p.id) + delta), p.available);
    setCart({ ...cart, [p.id]: next });
  };

  const lines = products.filter((p) => qty(p.id) > 0).map((p) => ({ productId: p.id, quantity: qty(p.id) }));
  const total = products.reduce((sum, p) => sum + p.pricePaise * qty(p.id), 0);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onPlaced(await placeOrder(lines));
    } catch (e) {
      // Someone else may have taken the units since the list loaded: say so and refresh.
      setError(e instanceof ApiError && e.code === 'insufficient_stock' ? 'Sorry, some items just sold out. The list has been refreshed.' : (e as Error).message);
      setCart({});
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Price</th>
            <th>Available</th>
            <th>In cart</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{rupees(p.pricePaise)}</td>
              <td>{p.available > 0 ? p.available : <span className="muted">Sold out</span>}</td>
              <td className="qty">
                <button onClick={() => change(p, -1)} disabled={qty(p.id) === 0} aria-label={`Remove one ${p.name}`}>
                  −
                </button>
                <span>{qty(p.id)}</span>
                <button onClick={() => change(p, 1)} disabled={qty(p.id) >= p.available} aria-label={`Add one ${p.name}`}>
                  +
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="bar">
        <strong>Total: {rupees(total)}</strong>
        <button className="primary" onClick={submit} disabled={lines.length === 0 || busy}>
          {busy ? 'Placing…' : 'Place order'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Payment({ order, deadline, onUpdate, onDone }: { order: Order; deadline: number | null; onUpdate: (o: Order) => void; onDone: () => void }) {
  const secondsLeft = useSecondsLeft(deadline);
  const waiting = order.status === 'pending';

  // Poll until the server says the order is no longer pending. The server, not the countdown,
  // decides when the hold is over.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      getOrder(order.id).then(onUpdate).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [order.id, waiting, onUpdate]);

  return (
    <section>
      <ul className="summary">
        {order.items.map((i) => (
          <li key={i.productId}>
            {i.quantity} × {i.name} <span className="muted">{rupees(i.unitPricePaise * i.quantity)}</span>
          </li>
        ))}
      </ul>
      <p>
        <strong>Total: {rupees(order.totalPaise)}</strong>
      </p>

      {waiting && (
        <div className="panel">
          <p>Pay by UPI to complete your order.</p>
          <p className="countdown" aria-live="polite">
            {secondsLeft > 0 ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'Checking…'}
          </p>
          <p className="muted">Your items are held until the timer ends.</p>
          <p className="muted small">
            Demo: simulate the payment with <code>npm run send-webhook -- {order.id}</code>
          </p>
        </div>
      )}
      {order.status === 'paid' && <Message kind="ok" title="Payment received" text="Collect your order from the locker." onDone={onDone} />}
      {order.status === 'picked_up' && <Message kind="ok" title="Collected" text="Enjoy your snacks!" onDone={onDone} />}
      {order.status === 'expired' && <Message kind="warn" title="Time is up" text="The hold has ended and the items were released. No payment was taken." onDone={onDone} />}
      {order.status === 'needs_review' && (
        <Message kind="warn" title="Payment needs a check" text="We received a payment we could not match automatically. Please ask the staff; any money taken will be refunded." onDone={onDone} />
      )}
    </section>
  );
}

function Message({ kind, title, text, onDone }: { kind: 'ok' | 'warn'; title: string; text: string; onDone: () => void }) {
  return (
    <div className={`panel ${kind}`} role="status">
      <h2>{title}</h2>
      <p>{text}</p>
      <button className="primary" onClick={onDone}>
        New order
      </button>
    </div>
  );
}
