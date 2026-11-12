// Merchant API (v1). Auth: `Authorization: Bearer pk_live_...`
import { q } from '../db.js';
import { requireApiKey } from '../auth.js';
import {
  cancelTransaction, createTransaction, publicCard, publicTx,
} from '../services/transactions.js';
import { ApiError, rateLimit } from '../util.js';

export default async function apiRoutes(app) {
  app.addHook('preHandler', requireApiKey);
  app.addHook('preHandler', async (req) => rateLimit('api:' + req.user.id, 600, 60_000));

  const find = (req) => {
    const t = q('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!t) throw new ApiError(404, 'not_found', 'Transaction not found');
    return t;
  };

  app.post('/transactions', async (req, reply) => {
    reply.code(201);
    return publicTx(createTransaction(req.user, req.body));
  });

  app.get('/transactions/:id', async (req) => publicTx(find(req)));

  app.get('/transactions', async (req) => {
    const { order_id: orderId, status } = req.query;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const where = ['user_id = ?'];
    const args = [req.user.id];
    if (orderId) { where.push('order_id = ?'); args.push(String(orderId)); }
    if (status) { where.push('status = ?'); args.push(String(status)); }
    const rows = q(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit);
    return { data: rows.map(publicTx) };
  });

  app.post('/transactions/:id/cancel', async (req) => publicTx(cancelTransaction(req.user, req.params.id)));

  app.get('/cards', async (req) => ({
    data: q('SELECT * FROM cards WHERE user_id = ? ORDER BY id').all(req.user.id).map((c) => publicCard(c, req.user)),
  }));
}
