// Merchant API (v1). Auth: `Authorization: Bearer pk_live_...`
import { q } from '../db.js';
import { requireApiKey } from '../auth.js';
import {
  cancelTransaction, createTransaction, publicCard, publicTx,
} from '../services/transactions.js';
import { merchantCards } from '../services/merchants.js';
import { ApiError, rateLimit } from '../util.js';

export default async function apiRoutes(app) {
  app.addHook('preHandler', requireApiKey);
  app.addHook('preHandler', async (req) => rateLimit('api:' + req.merchant.id, 600, 60_000));

  const find = (req) => {
    const t = q('SELECT * FROM transactions WHERE id = ? AND merchant_id = ?').get(req.params.id, req.merchant.id);
    if (!t) throw new ApiError(404, 'not_found', 'Transaction not found');
    return t;
  };

  app.post('/transactions', async (req, reply) => {
    reply.code(201);
    return publicTx(createTransaction(req.user, req.merchant, req.body));
  });

  app.get('/transactions/:id', async (req) => publicTx(find(req)));

  app.get('/transactions', async (req) => {
    const { order_id: orderId, status } = req.query;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const where = ['merchant_id = ?'];
    const args = [req.merchant.id];
    if (orderId) { where.push('order_id = ?'); args.push(String(orderId)); }
    if (status) { where.push('status = ?'); args.push(String(status)); }
    const rows = q(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit);
    return { data: rows.map(publicTx) };
  });

  app.post('/transactions/:id/cancel', async (req) => publicTx(cancelTransaction(req.merchant, req.params.id)));

  // Cards this merchant receives payments on.
  app.get('/cards', async (req) => ({
    data: merchantCards(req.merchant).map((c) => publicCard(c, req.user)),
  }));

  // The merchant this API key belongs to.
  app.get('/merchant', async (req) => ({
    id: req.merchant.id,
    name: req.merchant.name,
    website: req.merchant.website,
  }));
}
