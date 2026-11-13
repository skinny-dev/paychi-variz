// Variza-compatible API, so software already written for Variza (e.g. Mirza bots) can switch to
// Paychi by changing only the API address, API token and webhook secret.
//   POST /api/compat/variza/v1/pay   { amount (Toman), return_url?, title?, expires_in? ("1h", "30m", 600) }
//   → 201 { slug, pay_url, amount, status, expires_at }
// Set the merchant's webhook format to "variza" to receive Variza-style webhooks
// (event "payment.paid", X-Webhook-Signature: sha256=HMAC(secret, body)). Amounts are Toman here.
import { requireApiKey } from '../auth.js';
import { config } from '../config.js';
import { createTransaction, publicTx } from '../services/transactions.js';
import { ApiError, rateLimit } from '../util.js';

function ttlSeconds(v) {
  if (v == null || v === '') return undefined;
  const m = /^(\d+)\s*([smhd]?)$/i.exec(String(v).trim());
  if (!m) throw new ApiError(400, 'invalid_expires_in', 'expires_in must look like 600, "30m" or "1h"');
  const sec = Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
  return Math.min(Math.max(sec, config.txMinTtlSec), config.txMaxTtlSec);
}

export default async function compatRoutes(app) {
  app.addHook('preHandler', requireApiKey);
  app.addHook('preHandler', async (req) => rateLimit('api:' + req.merchant.id, 600, 60_000));

  app.post('/variza/v1/pay', async (req, reply) => {
    const b = req.body ?? {};
    const toman = Number(b.amount);
    if (!Number.isSafeInteger(toman) || toman < config.minAmount / 10) {
      throw new ApiError(400, 'invalid_amount', `amount (Toman) must be an integer >= ${config.minAmount / 10}`);
    }
    const t = createTransaction(req.user, req.merchant, {
      amount: toman * 10,
      description: b.title ?? b.description ?? null,
      return_url: b.return_url ?? null,
      callback_url: b.callback_url ?? null,
      ttl: ttlSeconds(b.expires_in),
      metadata: { compat: 'variza', ...(b.metadata && typeof b.metadata === 'object' ? b.metadata : {}) },
    });
    const p = publicTx(t);
    reply.code(201);
    return {
      slug: p.id,
      pay_url: p.payment_url,
      amount: Math.floor(p.amount / 10), // Toman; the payment page shows the exact Rial amount
      amount_rial: p.amount,
      status: p.status,
      expires_at: p.expires_at,
    };
  });
}
