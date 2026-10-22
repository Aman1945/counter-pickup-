import { createApp } from './app.ts';
import { createPool, migrate, seedIfEmpty } from './db.ts';
import { expireDueOrders } from './orders.ts';

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://pickup:pickup@localhost:5433/pickup';
const webhookSecret = process.env.WEBHOOK_SECRET;
const holdSeconds = Number(process.env.HOLD_SECONDS ?? 120);

if (!webhookSecret) {
  console.error('WEBHOOK_SECRET is not set');
  process.exit(1);
}

const db = createPool(databaseUrl);

// Postgres may still be starting when the container comes up.
for (let attempt = 1; ; attempt++) {
  try {
    await migrate(db);
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    console.log(`waiting for database (${attempt})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await seedIfEmpty(db);

const app = createApp({ db, webhookSecret, holdSeconds, webDir: process.env.WEB_DIR });
app.listen(port, () => console.log(`api listening on :${port} (hold ${holdSeconds}s)`));

// Keeps the stored status honest for reporting. Stock correctness does not depend on this:
// holds are always computed from expires_at.
setInterval(() => {
  expireDueOrders(db).catch((err) => console.error('expiry sweep failed', err));
}, 5000);
