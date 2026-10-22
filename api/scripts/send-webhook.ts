// Sends a correctly signed payment webhook, like the provider would.
//
//   npm run send-webhook -- <orderId>                     pays the exact order total
//   npm run send-webhook -- <orderId> 999                 pays a different amount (needs_review)
//   npm run send-webhook -- <orderId> 4500 evt_fixed      reuse an event id to see idempotency
//   npm run send-webhook -- <orderId> 4500 evt_x failed   any other status
//
// Env: API_URL (default http://localhost:3000), WEBHOOK_SECRET (default matches docker-compose.yml)
import crypto from 'node:crypto';

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const secret = process.env.WEBHOOK_SECRET ?? 'local-dev-secret';
const [orderId, amountArg, eventArg, statusArg] = process.argv.slice(2);

if (!orderId) {
  console.error('usage: npm run send-webhook -- <orderId> [amountPaise] [eventId] [status]');
  process.exit(1);
}

let amountPaise = amountArg === undefined ? undefined : Number(amountArg);
if (amountPaise === undefined) {
  const res = await fetch(`${apiUrl}/orders/${orderId}`);
  if (!res.ok) {
    console.error(`could not read order ${orderId}: HTTP ${res.status}`);
    process.exit(1);
  }
  amountPaise = (await res.json()).totalPaise;
}

const body = JSON.stringify({
  eventId: eventArg ?? `evt_${crypto.randomUUID()}`,
  orderId,
  amountPaise,
  status: statusArg ?? 'captured',
});
const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

const res = await fetch(`${apiUrl}/payments/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-signature': signature },
  body,
});
console.log(`POST /payments/webhook ${body}`);
console.log(`-> HTTP ${res.status} ${await res.text()}`);
