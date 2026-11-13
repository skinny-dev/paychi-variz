// Public data for the payment page. The transaction id is the only secret needed.
import { q } from '../db.js';
import { bankInfo } from '../banks.js';
import { ApiError, iso, rateLimit } from '../util.js';
import { publicLink, startLinkPayment } from '../services/links.js';

export default async function payRoutes(app) {
  // Payment links (/l/<slug>): show the link, then start a transaction for the payer.
  app.get('/link/:slug', async (req, reply) => {
    rateLimit('link:' + req.ip, 240, 60_000);
    reply.header('cache-control', 'no-store');
    return publicLink(req.params.slug);
  });
  app.post('/link/:slug', async (req) => {
    // Each start reserves a unique amount and card capacity until it expires: keep it modest.
    rateLimit('linkstart:' + req.ip, 15, 3600_000);
    rateLimit('linkstart:' + req.params.slug, 300, 3600_000);
    const t = startLinkPayment(req.params.slug, req.body ?? {});
    return { id: t.id, payment_url: `/pay/${t.id}` };
  });

  app.get('/:id', async (req, reply) => {
    rateLimit('pay:' + req.ip, 240, 60_000);
    const t = q('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    if (!t) throw new ApiError(404, 'not_found', 'تراکنش پیدا نشد');
    const card = q('SELECT * FROM cards WHERE id = ?').get(t.card_id);
    const bank = bankInfo(card.bank_code);
    const open = t.status === 'pending';
    reply.header('cache-control', 'no-store');
    return {
      id: t.id,
      status: t.status,
      amount: t.amount,
      description: t.description,
      merchant_name: t.merchant_id ? q('SELECT name FROM merchants WHERE id = ?').get(t.merchant_id)?.name ?? null : null,
      // Card details are only exposed while the transaction is payable.
      card: open
        ? { number: card.number, holder_name: card.holder_name, bank: bank.code, bank_name: bank.name, colors: bank.colors }
        : null,
      return_url: t.return_url,
      expires_at: iso(t.expires_at),
      paid_at: iso(t.paid_at),
      server_time: new Date().toISOString(),
    };
  });
}
