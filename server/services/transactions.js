import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { bankInfo } from '../banks.js';
import { requireSubscription } from '../auth.js';
import { normalizeDigits, parseBankMessage } from '../parser.js';
import { detectBank, identifyCard } from '../bankDetect.js';
import { ApiError, httpUrl, iso, positiveInt, sha256, tehranDayStart } from '../util.js';
import { enqueueWebhook } from './webhooks.js';
import { merchantCards } from './merchants.js';
import { notifyHeld, notifyPaid } from './telegram.js';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newTxId = () =>
  'tx_' + Array.from(randomBytes(18), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');

export const effectiveLimit = (card, user) =>
  card.daily_limit ?? user.default_card_limit ?? config.defaultCardLimit;

/** Rial already received today (Tehran day) plus Rial reserved by open transactions. */
export function cardUsage(cardId, now = Date.now()) {
  const paid = q(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE card_id = ? AND status = 'paid' AND paid_at >= ?`,
  ).get(cardId, tehranDayStart(now)).s;
  const reserved = q(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE card_id = ? AND status = 'pending'`,
  ).get(cardId).s;
  return { paid, reserved };
}

export function publicCard(card, user) {
  const bank = bankInfo(card.bank_code);
  const { paid, reserved } = cardUsage(card.id);
  const limit = effectiveLimit(card, user);
  return {
    id: card.id,
    number: card.number,
    bank: bank.code,
    bank_name: bank.name,
    holder_name: card.holder_name,
    account_number: card.account_number ?? null,
    active: !!card.active,
    daily_limit: limit,
    daily_limit_is_custom: card.daily_limit != null,
    received_today: paid,
    reserved,
    remaining_today: Math.max(0, limit - paid - reserved),
  };
}

export function publicTx(t) {
  const card = q('SELECT * FROM cards WHERE id = ?').get(t.card_id);
  const merchant = t.merchant_id ? q('SELECT id, name FROM merchants WHERE id = ?').get(t.merchant_id) : null;
  const bank = bankInfo(card.bank_code);
  return {
    id: t.id,
    status: t.status,
    amount: t.amount,
    requested_amount: t.requested_amount,
    currency: 'IRR',
    merchant: merchant ? { id: merchant.id, name: merchant.name } : null,
    order_id: t.order_id,
    description: t.description,
    card: {
      id: card.id,
      number: card.number,
      bank: bank.code,
      bank_name: bank.name,
      holder_name: card.holder_name,
    },
    payment_url: `${config.baseUrl}/pay/${t.id}`,
    return_url: t.return_url,
    metadata: t.metadata ? JSON.parse(t.metadata) : null,
    created_at: iso(t.created_at),
    expires_at: iso(t.expires_at),
    paid_at: iso(t.paid_at),
  };
}

/**
 * Smallest amount >= requested that no open / recently closed transaction of this account uses.
 * Unique across all of the account's merchants: one phone receives every merchant's deposits and
 * the amount is what tells them apart.
 */
function uniqueAmount(userId, requested, now) {
  const taken = new Set(
    q(
      `SELECT amount FROM transactions
       WHERE user_id = ? AND amount BETWEEN ? AND ?
         AND (status = 'pending' OR (status IN ('expired', 'cancelled') AND ended_at > ?))`,
    )
      .all(userId, requested, requested + config.maxAmountDelta, now - config.amountCooldownSec * 1000)
      .map((r) => r.amount),
  );
  for (let d = 0; d <= config.maxAmountDelta; d++) {
    if (!taken.has(requested + d)) return requested + d;
  }
  throw new ApiError(409, 'no_unique_amount', 'Too many open transactions with this amount; retry shortly');
}

function pickCard(user, merchant, amount, cardId) {
  const cards = merchantCards(merchant).filter((c) => c.active && (!cardId || c.id === cardId));
  if (!cards.length) {
    throw new ApiError(422, cardId ? 'card_not_found' : 'no_active_card', 'No active card available');
  }
  let best = null;
  for (const card of cards) {
    const { paid, reserved } = cardUsage(card.id);
    const limit = effectiveLimit(card, user);
    const used = paid + reserved;
    if (used + amount > limit) continue;
    const ratio = limit ? used / limit : 1;
    if (!best || ratio < best.ratio) best = { card, ratio };
  }
  if (!best) {
    throw new ApiError(422, 'card_limit_reached', 'Daily card-to-card limit reached on all eligible cards');
  }
  return best.card;
}

export function createTransaction(user, merchant, input = {}) {
  const sub = requireSubscription(user.id);
  if (!merchant.active) throw new ApiError(403, 'merchant_inactive', 'This merchant is deactivated');
  const requested = positiveInt(input.amount, 'amount', { min: config.minAmount, max: 10_000_000_000 });
  const ttl =
    input.ttl == null
      ? Math.min(Math.max(merchant.tx_ttl_sec ?? config.txTtlSec, config.txMinTtlSec), config.txMaxTtlSec)
      : positiveInt(input.ttl, 'ttl', { min: config.txMinTtlSec, max: config.txMaxTtlSec });
  const callbackUrl = httpUrl(input.callback_url, 'callback_url');
  const returnUrl = httpUrl(input.return_url, 'return_url');
  const orderId = input.order_id == null ? null : String(input.order_id).slice(0, 128);
  const description = input.description == null ? null : String(input.description).slice(0, 255);
  let metadata = null;
  if (input.metadata != null) {
    if (typeof input.metadata !== 'object') throw new ApiError(400, 'invalid_metadata', 'metadata must be an object');
    metadata = JSON.stringify(input.metadata);
    if (metadata.length > 4000) throw new ApiError(400, 'invalid_metadata', 'metadata is too large');
  }
  const cardId = input.card_id == null ? null : positiveInt(input.card_id, 'card_id');

  return tx(() => {
    const now = Date.now();
    if (sub.plan.maxTxPerPeriod != null) {
      const used = q('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND created_at >= ?')
        .get(user.id, sub.starts_at).c;
      if (used >= sub.plan.maxTxPerPeriod) {
        throw new ApiError(402, 'plan_limit_reached', 'Transaction quota of the current plan is used up');
      }
    }
    const amount = uniqueAmount(user.id, requested, now);
    const card = pickCard(user, merchant, amount, cardId);
    const id = newTxId();
    q(
      `INSERT INTO transactions
         (id, user_id, merchant_id, card_id, requested_amount, amount, status, order_id, description,
          callback_url, return_url, metadata, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, merchant.id, card.id, requested, amount, orderId, description, callbackUrl, returnUrl, metadata, now, now + ttl * 1000);
    return q('SELECT * FROM transactions WHERE id = ?').get(id);
  });
}

/** Cancel a pending transaction of this merchant. */
export function cancelTransaction(merchant, id) {
  const now = Date.now();
  const res = q(
    `UPDATE transactions SET status = 'cancelled', ended_at = ? WHERE id = ? AND merchant_id = ? AND status = 'pending'`,
  ).run(now, id, merchant.id);
  const t = q('SELECT * FROM transactions WHERE id = ? AND merchant_id = ?').get(id, merchant.id);
  if (!t) throw new ApiError(404, 'not_found', 'Transaction not found');
  if (!res.changes) throw new ApiError(409, 'not_pending', `Transaction is already ${t.status}`);
  enqueueWebhook(t, 'transaction.cancelled', publicTx(t));
  return t;
}

/** Expire overdue transactions (after the grace period) and notify merchants. */
export function expireTransactions() {
  const now = Date.now();
  const due = q(`SELECT * FROM transactions WHERE status = 'pending' AND expires_at < ? LIMIT 200`)
    .all(now - config.graceSec * 1000);
  for (const t of due) {
    const res = q(`UPDATE transactions SET status = 'expired', ended_at = ? WHERE id = ? AND status = 'pending'`)
      .run(now, t.id);
    if (!res.changes) continue;
    enqueueWebhook(t, 'transaction.expired', publicTx({ ...t, status: 'expired' }));
  }
}

const MOBILE_SENDER = /^(\+?98|0098|0)?9\d{9}$/;

/**
 * Decide whether a sender may confirm payments.
 * - If the user listed senders for this type, only those are accepted (strict mode).
 * - Otherwise everything is accepted except SMS from ordinary mobile numbers: banks send
 *   from sender names / short codes, and a text from a personal number is the easy way to fake a deposit.
 */
function checkSender(userId, type, sender) {
  const listed = q('SELECT value FROM sources WHERE user_id = ? AND type = ? AND enabled = 1').all(userId, type);
  if (listed.length) {
    const ok = listed.some((s) => s.value.toLowerCase() === sender.toLowerCase());
    return { ok, strict: true, reason: 'source_not_allowed' };
  }
  if (type === 'sms' && MOBILE_SENDER.test(normalizeDigits(sender).replace(/[\s-]/g, ''))) {
    return { ok: false, strict: false, reason: 'sender_is_mobile_number' };
  }
  return { ok: true, strict: false };
}

/** Handle a message forwarded by a listener device (SMS and app notifications alike). */
export function ingestMessage(user, device, input = {}) {
  const type = input.type === 'notification' ? 'notification' : 'sms';
  const sender = String(input.sender ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (!sender || !body) throw new ApiError(400, 'invalid_message', 'sender and body are required');
  if (body.length > 4000) throw new ApiError(400, 'invalid_message', 'body is too long');

  const check = checkSender(user.id, type, sender);
  if (!check.ok) return { accepted: false, reason: check.reason, matched: false };

  const parsed = parseBankMessage(body);
  // Without an explicit sender list, anything that is not a deposit is dropped unstored.
  if (!check.strict && !parsed.isDeposit) return { accepted: false, reason: 'not_a_deposit', matched: false };
  const now = Date.now();
  const dedupe = sha256([user.id, type, sender.toLowerCase(), body, input.received_at ?? ''].join('\u0001'));

  return tx(() => {
    const ins = q(
      `INSERT OR IGNORE INTO events (user_id, device_id, type, sender, body, amount, is_deposit, dedupe, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(user.id, device?.id ?? null, type, sender, body, parsed.amount, parsed.isDeposit ? 1 : 0, dedupe, now);
    if (!ins.changes) return { accepted: true, duplicate: true, matched: false };
    const eventId = Number(ins.lastInsertRowid);
    const { bank, cardId } = identifyMessage(user.id, type, sender, body);
    const finish = (result) => {
      q('UPDATE events SET bank_code = ?, card_id = ?, result = ? WHERE id = ?')
        .run(bank, cardId, result.reason ?? 'matched', eventId);
      return { accepted: true, ...result, bank, card_id: cardId };
    };
    if (!parsed.isDeposit) return finish({ matched: false, reason: 'not_a_deposit' });

    const t = q(
      `SELECT * FROM transactions WHERE user_id = ? AND status = 'pending' AND amount = ? ORDER BY created_at LIMIT 1`,
    ).get(user.id, parsed.amount);
    if (!t) return finish({ matched: false, amount: parsed.amount, reason: 'no_pending_transaction' });

    // Right amount, but the message says the money reached a different card / bank than the
    // transaction told the payer to use: not confirmed automatically (confirm by hand in the
    // dashboard). A named card is the stronger signal, so it is checked first.
    const txCard = q('SELECT id, bank_code FROM cards WHERE id = ?').get(t.card_id);
    if (cardId && cardId !== txCard.id) {
      notifyHeld(t, 'card_mismatch');
      return finish({ matched: false, amount: parsed.amount, reason: 'card_mismatch', transaction_id: t.id });
    }
    if (!cardId && bank && txCard.bank_code !== 'unknown' && bank !== txCard.bank_code) {
      notifyHeld(t, 'bank_mismatch');
      return finish({ matched: false, amount: parsed.amount, reason: 'bank_mismatch', transaction_id: t.id });
    }

    markPaid(t, eventId, now);
    return finish({ matched: true, amount: parsed.amount, transaction_id: t.id });
  });
}

function markPaid(t, eventId, now = Date.now()) {
  q(`UPDATE transactions SET status = 'paid', paid_at = ?, ended_at = ?, event_id = ? WHERE id = ?`)
    .run(now, now, eventId, t.id);
  q('UPDATE events SET tx_id = ? WHERE id = ?').run(t.id, eventId);
  const paid = q('SELECT * FROM transactions WHERE id = ?').get(t.id);
  enqueueWebhook(paid, 'transaction.paid', publicTx(paid));
  notifyPaid(paid);
}

/**
 * Which bank (and, if the text names one, which of the user's cards) a message is about.
 * A bank the user set for the sender wins; otherwise it is read from the sender name / text and
 * remembered for that sender, so later messages without the bank's name are still recognised.
 * Works the same for SMS senders and notification app packages.
 */
function identifyMessage(userId, type, sender, body) {
  const key = sender.toLowerCase();
  const mapped = q('SELECT bank_code FROM sender_banks WHERE user_id = ? AND type = ? AND sender = ?')
    .get(userId, type, key);
  let bank = mapped?.bank_code ?? null;
  if (!bank) {
    bank = detectBank(sender, body);
    if (bank) {
      q('INSERT OR IGNORE INTO sender_banks (user_id, type, sender, bank_code, auto, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(userId, type, key, bank, Date.now());
    }
  }
  const cards = q('SELECT id, number, account_number FROM cards WHERE user_id = ?').all(userId);
  return { bank, cardId: identifyCard(body, cards) };
}

/**
 * Confirm a received message by hand: pays the pending transaction with the message's amount
 * (or the one given) even though the bank / card did not match.
 */
export function confirmEvent(user, eventId, txId) {
  return tx(() => {
    const e = q('SELECT * FROM events WHERE id = ? AND user_id = ?').get(eventId, user.id);
    if (!e) throw new ApiError(404, 'not_found', 'پیام پیدا نشد');
    if (e.tx_id) throw new ApiError(409, 'already_matched', 'این پیام قبلاً به تراکنش وصل شده است');
    const t = txId
      ? q(`SELECT * FROM transactions WHERE id = ? AND user_id = ? AND status = 'pending'`).get(txId, user.id)
      : q(`SELECT * FROM transactions WHERE user_id = ? AND status = 'pending' AND amount = ? ORDER BY created_at LIMIT 1`)
        .get(user.id, e.amount);
    if (!t) throw new ApiError(409, 'no_pending_transaction', 'تراکنش در انتظاری با این مبلغ وجود ندارد');
    markPaid(t, e.id);
    q(`UPDATE events SET result = 'confirmed_manually' WHERE id = ?`).run(e.id);
    return q('SELECT * FROM transactions WHERE id = ?').get(t.id);
  });
}
