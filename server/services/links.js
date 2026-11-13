// Payment links: no-code payments. The merchant shares /l/<slug>; the payer opens it, (enters the
// amount,) and is sent to the normal payment page of a fresh transaction.
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { q } from '../db.js';
import { ApiError, positiveInt } from '../util.js';
import { normalizeDigits } from '../parser.js';
import { createTransaction } from './transactions.js';
import { getMerchant } from './merchants.js';

const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newSlug = () => Array.from(randomBytes(8), (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');
const MAX_AMOUNT = 10_000_000_000;

const optAmount = (v, field) =>
  v == null || v === '' ? null : positiveInt(v, field, { min: config.minAmount, max: MAX_AMOUNT });
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;

function cleanLink(b, prev = {}) {
  const pick = (k, fn) => (k in b ? fn(b[k]) : prev[k] ?? null);
  const out = {
    title: pick('title', (v) => text(v, 120)),
    description: pick('description', (v) => text(v, 500)),
    amount: pick('amount', (v) => optAmount(v, 'amount')),
    min_amount: pick('min_amount', (v) => optAmount(v, 'min_amount')),
    max_amount: pick('max_amount', (v) => optAmount(v, 'max_amount')),
    ask_payer: 'ask_payer' in b ? (b.ask_payer ? 1 : 0) : prev.ask_payer ?? 0,
    active: 'active' in b ? (b.active ? 1 : 0) : prev.active ?? 1,
  };
  if (!out.title) throw new ApiError(400, 'invalid_title', 'عنوان لینک را وارد کنید');
  if (out.min_amount && out.max_amount && out.min_amount > out.max_amount) {
    throw new ApiError(400, 'invalid_range', 'حداقل مبلغ از حداکثر بیشتر است');
  }
  return out;
}

export function createLink(userId, merchantId, b = {}) {
  const m = getMerchant(userId, merchantId);
  if (q('SELECT COUNT(*) AS c FROM payment_links WHERE merchant_id = ?').get(m.id).c >= 500) {
    throw new ApiError(400, 'too_many_links', 'حداکثر ۵۰۰ لینک برای هر فروشگاه');
  }
  const l = cleanLink(b);
  const res = q(
    `INSERT INTO payment_links (slug, user_id, merchant_id, title, description, amount, min_amount, max_amount, ask_payer, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newSlug(), userId, m.id, l.title, l.description, l.amount, l.min_amount, l.max_amount, l.ask_payer, l.active, Date.now());
  return q('SELECT * FROM payment_links WHERE id = ?').get(Number(res.lastInsertRowid));
}

export function getLink(userId, id) {
  const l = q('SELECT * FROM payment_links WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!l) throw new ApiError(404, 'not_found', 'لینک پیدا نشد');
  return l;
}

export function updateLink(userId, id, b = {}) {
  const prev = getLink(userId, id);
  const l = cleanLink(b, prev);
  q(`UPDATE payment_links SET title = ?, description = ?, amount = ?, min_amount = ?, max_amount = ?, ask_payer = ?, active = ?
     WHERE id = ?`).run(l.title, l.description, l.amount, l.min_amount, l.max_amount, l.ask_payer, l.active, prev.id);
  return getLink(userId, id);
}

/** Delete a link; one that already has transactions is only deactivated. */
export function deleteLink(userId, id) {
  const l = getLink(userId, id);
  if (q('SELECT 1 FROM transactions WHERE link_id = ? LIMIT 1').get(l.id)) {
    q('UPDATE payment_links SET active = 0 WHERE id = ?').run(l.id);
    return { deactivated: true };
  }
  q('DELETE FROM payment_links WHERE id = ?').run(l.id);
  return { deactivated: false };
}

export const linkUrl = (l) => `${config.baseUrl}/l/${l.slug}`;

/** Link as shown in the dashboard. */
export async function dashLink(l) {
  const s = q(
    `SELECT COUNT(*) FILTER (WHERE status = 'paid') AS paid, COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid_sum
     FROM transactions WHERE link_id = ?`,
  ).get(l.id);
  const url = linkUrl(l);
  return {
    id: l.id,
    slug: l.slug,
    url,
    qr_svg: await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }),
    title: l.title,
    description: l.description,
    amount: l.amount,
    min_amount: l.min_amount,
    max_amount: l.max_amount,
    ask_payer: !!l.ask_payer,
    active: !!l.active,
    paid: s.paid,
    paid_sum: s.paid_sum,
  };
}

function activeLink(slug) {
  const l = q('SELECT * FROM payment_links WHERE slug = ?').get(String(slug));
  const m = l && q('SELECT * FROM merchants WHERE id = ?').get(l.merchant_id);
  if (!l || !m) throw new ApiError(404, 'not_found', 'لینک پرداخت پیدا نشد');
  return { l, m, open: !!(l.active && m.active) };
}

/** What the public link page shows. */
export function publicLink(slug) {
  const { l, m, open } = activeLink(slug);
  return {
    title: l.title,
    description: l.description,
    merchant_name: m.name,
    amount: l.amount,
    min_amount: l.min_amount ?? config.minAmount,
    max_amount: l.max_amount,
    ask_payer: !!l.ask_payer,
    active: open,
  };
}

/** Payer pressed "pay": create a transaction of the link's merchant. Returns the transaction row. */
export function startLinkPayment(slug, b = {}) {
  const { l, m, open } = activeLink(slug);
  if (!open) throw new ApiError(410, 'link_inactive', 'این لینک پرداخت غیرفعال است');
  let amount = l.amount;
  if (amount == null) {
    const min = l.min_amount ?? config.minAmount;
    const max = l.max_amount ?? MAX_AMOUNT;
    try {
      amount = positiveInt(normalizeDigits(String(b.amount ?? '')).replace(/[,\s٬]/g, ''), 'amount', { min, max });
    } catch {
      throw new ApiError(400, 'invalid_amount', `مبلغ باید بین ${min.toLocaleString('fa-IR')} و ${max.toLocaleString('fa-IR')} ریال باشد`);
    }
  }
  let metadata = { payment_link: l.slug };
  if (l.ask_payer) {
    const name = text(b.payer_name, 80);
    const phone = normalizeDigits(String(b.payer_phone ?? '')).replace(/[\s-]/g, '').slice(0, 20) || null;
    if (!name || !phone) throw new ApiError(400, 'payer_required', 'نام و شماره تماس را وارد کنید');
    metadata = { ...metadata, payer_name: name, payer_phone: phone };
  }
  const user = q('SELECT * FROM users WHERE id = ?').get(l.user_id);
  let t;
  try {
    t = createTransaction(user, m, { amount, description: l.title, metadata });
  } catch (e) {
    // The payer only needs to know it cannot be paid right now (details are for the merchant).
    if (e instanceof ApiError && e.status !== 400) {
      throw new ApiError(e.status, e.code, 'در حال حاضر امکان پرداخت با این لینک نیست؛ کمی بعد دوباره تلاش کنید.');
    }
    throw e;
  }
  q('UPDATE transactions SET link_id = ? WHERE id = ?').run(l.id, t.id);
  return t;
}
