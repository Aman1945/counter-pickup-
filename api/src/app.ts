import fs from 'node:fs';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { claimPickup, createOrder, getOrder, parseOrderItems } from './orders.ts';
import { applyWebhook, parseEvent, verifySignature } from './payments.ts';
import { listProducts } from './stock.ts';

export type AppConfig = { db: Db; webhookSecret: string; holdSeconds: number; webDir?: string };

export function createApp(cfg: AppConfig): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/products', async (_req, res) => {
    res.json({ products: await listProducts(cfg.db) });
  });

  app.post('/orders', express.json(), async (req, res) => {
    const order = await createOrder(cfg.db, parseOrderItems(req.body), cfg.holdSeconds);
    res.status(201).json(order);
  });

  app.get('/orders/:id', async (req, res) => {
    const order = await getOrder(cfg.db, req.params.id);
    if (!order) throw new AppError(404, 'order_not_found', 'Order not found');
    res.json(order);
  });

  app.post('/orders/:id/pickup-claim', async (req, res) => {
    res.json(await claimPickup(cfg.db, req.params.id));
  });

  // Raw body: the signature is over the exact bytes the provider sent, so we must not re-serialise JSON.
  app.post('/payments/webhook', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.header('x-signature'), cfg.webhookSecret)) {
      throw new AppError(401, 'invalid_signature', 'Signature does not match');
    }
    res.json(await applyWebhook(cfg.db, parseEvent(raw)));
  });

  // The built customer screen (production image only).
  if (cfg.webDir && fs.existsSync(cfg.webDir)) app.use(express.static(cfg.webDir));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'Body is not valid JSON' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  return app;
}
