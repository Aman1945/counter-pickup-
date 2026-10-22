# Pickup Counter

A self-service snack counter: pick items, pay by UPI (simulated webhook), collect from a locker.
Backend: Node.js + Express 5 + PostgreSQL, TypeScript throughout. Customer screen: React + Vite.

## Run it

```bash
docker compose up --build
```

Open http://localhost:3000. The database is created and seeded with five products on first start.

Pay for an order (the screen shows its id):

```bash
npm run send-webhook -- <orderId>                     # pays the exact total
npm run send-webhook -- <orderId> 999                 # wrong amount -> needs_review
npm run send-webhook -- <orderId> <amount> evt_same   # send twice to see idempotency
```

The script signs the body with `WEBHOOK_SECRET` (default `local-dev-secret`, the same default as `docker-compose.yml`) and reads the order total from the API if no amount is given. It needs Node 23.6+ on the host (it runs TypeScript directly); or run it inside the container: `docker compose exec app node scripts/send-webhook.ts <orderId>` with `API_URL=http://localhost:3000`.

Claim a pickup: `curl -X POST localhost:3000/orders/<orderId>/pickup-claim`

## Run the tests

```bash
docker compose up -d db      # or the whole stack
npm test                     # runs inside the app container against the real pickup_test database
```

Or from `api/` on the host: `npm install && npm test` (uses `postgres://pickup:pickup@localhost:5433/pickup_test`).

20 tests, all against a real PostgreSQL database through the real HTTP app. No mocks. The three required ones:

| Required | Test |
|---|---|
| Ten customers order the last two units at the same moment | `orders.test.ts`: 2 × 201, 8 × 409 `insufficient_stock`, exactly 2 units held, available = 0 |
| The same webhook event twice | `payments.test.ts`: sequential and simultaneous; one `payment_events` row, second reply `duplicate: true` |
| Two simultaneous pickup claims | `pickup.test.ts`: one 200, one 409, stock reduced once (also with ten lockers) |

Others: all-or-nothing orders, expiry releasing units, wrong/missing signature, amount mismatch, second capture, non-captured status, unknown order, both late-payment branches, unpaid and expired claims. Tests use a 2-second hold so expiry can be tested quickly.

## API

| Method | Path | |
|---|---|---|
| GET | `/products` | `available = stock − units held` |
| POST | `/orders` | `{ "items": [{ "productId": 1, "quantity": 2 }] }` → 201 order with `totalPaise`, `expiresInSeconds` |
| GET | `/orders/:id` | current status and `expiresInSeconds` |
| POST | `/payments/webhook` | signed with `X-Signature` |
| POST | `/orders/:id/pickup-claim` | 200, or 409 with the reason |

Errors are `{ "error": { "code", "message", "details" } }`.

## How correctness is kept

**Money.** Integer paise everywhere: `integer` columns, `Number.isSafeInteger` validation, and the screen formats paise without floating-point maths.

**What "held" means.** One SQL definition in `api/src/stock.ts`, used by every query:
an order holds its units while it is `pending` with `expires_at > now()`, or `paid` (paid but not yet collected; the units are still in the counter). `available = stock − held`. Expiry is decided by `expires_at` against the database clock, so a hold ends exactly on time even if the background sweep (which only updates the stored status every 5 s) is late.

**No overselling.** Creating an order locks the product rows (`SELECT … FOR UPDATE`, in id order so two orders never deadlock), then reads availability, then inserts. A competing order waits for the lock and then sees the first order's hold. If any line is short, the transaction rolls back and nothing is held. `CHECK (stock >= 0)` is a last line of defence.

**Webhooks exactly once.** The signature is checked over the raw request bytes (`express.raw`), with a constant-time compare. Then, in one transaction: insert the event into `payment_events` (`event_id` primary key) with `ON CONFLICT DO NOTHING`; only if the insert happened, lock the order row and apply the change. A repeated event, even one arriving at the same moment, hits the primary key and changes nothing. It gets 200 with `duplicate: true`, so the provider stops retrying.

**One pickup.** `UPDATE orders SET status = 'picked_up' WHERE id = $1 AND status = 'paid'`. Postgres makes the second claim wait for the first, then re-checks the condition, finds `picked_up`, and updates nothing → 409. The same transaction reduces `stock` permanently.

**Countdown with a wrong clock.** The server sends `expiresInSeconds`, computed in SQL from the same database clock that set `expires_at` (`api/src/orders.ts`). The screen turns it into a deadline on `performance.now()`, a monotonic timer that ignores the device's wall clock (`web/src/countdown.ts`), and re-syncs on every poll. `Date.now()` is never used. The screen only decides what to show from the server's status, never from its own timer.

## Decisions on the open questions

**Late payment (a valid capture after the hold expired).** I honour it if I can and send it to review if I can't:
- Lock the order's products and check availability right now. If every unit is still free, mark the order `paid` (outcome `paid_late`). The customer paid the right amount and the snacks are there, so refusing would only create a refund for nothing.
- If any unit has been taken by someone else since, mark the order `needs_review` with the reason "refund needed" (outcome `late_no_stock`). The customer who now holds those units keeps them; I never take stock away from an order that followed the rules.
Why not always refund? It's the worst experience for the common case (a slow UPI confirmation with plenty of stock). Why not always accept? It could oversell. This takes the sale when it's safe and is otherwise a refund queue.

**`needs_review` holds no stock.** A mismatched or unsellable payment needs a human. Holding units indefinitely while it waits would block other customers, so the units are released and staff can re-sell or refund.

**Other event cases** (all answered 200 so the provider doesn't retry forever, and all recorded with an outcome):
- `already_settled`: a different capture event for an order that is already paid → no change (a second charge, to be refunded).
- `not_captured`: any status other than `captured` → recorded, order unchanged (the customer can still pay within the hold).
- `unknown_order`: no such order → recorded only.

**Pickup errors.** All refusals are 409 with the current status in `details` (`pending`, `expired`, `needs_review`, `picked_up`); unknown order is 404.

## Assumptions

- One currency (INR), prices fixed at order time (`order_items.unit_price_paise`).
- An order may contain several products; repeated product ids in one request are merged. At most 50 units of a product per order.
- The provider's `amountPaise` is an integer in paise; the same `eventId` always carries the same payload. If a reused id carries a different payload, the first one wins.
- The webhook secret comes from `WEBHOOK_SECRET`. The compose file has a local-development default; a real deployment would inject it from a secret store.
- There is no customer login; the order id (a random UUID) is what the screen and locker use.

## How I checked it

- The automated tests above, run repeatedly (5 runs in a row, no flaky failures) against Postgres 17 in Docker.
- By hand against `docker compose up`: a wrong-amount webhook (→ `needs_review`, the repeat came back `duplicate: true`, pickup refused), a correct payment followed by two simultaneous `curl` pickup claims (one 200, one 409, stock down once).
- In a browser: placed an order with the page's `Date` shifted 7 minutes ahead (the countdown still started at 1:58 and ticked correctly), saw it switch to "Payment received" after the webhook, and with a short hold saw "Time is up".

## What I would do next with more time

- A small staff view for `needs_review` orders (refund or re-sell), and a real refund call for `late_no_stock` / `already_settled`.
- Reject webhook events older than a few minutes (timestamp in the signed payload) to limit replay.
- Rate limiting on `POST /orders` so one client can't hold all the stock.
- Push status to the screen (SSE) instead of polling every 2 s.
- Structured logs and metrics: holds created/expired, webhook outcomes, 409 rates.
- Front-end tests for the countdown and the status screens.
