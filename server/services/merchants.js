import { config } from '../config.js';
import { q, tx } from '../db.js';
import { ApiError, httpUrl, iso, positiveInt, randomToken, sha256 } from '../util.js';

const MAX_MERCHANTS = 200;

const cleanName = (v) => {
  const name = String(v ?? '').trim().slice(0, 80);
  if (!name) throw new ApiError(400, 'invalid_name', 'نام فروشگاه را وارد کنید');
  return name;
};

export function createMerchant(userId, input = {}) {
  if (q('SELECT COUNT(*) AS c FROM merchants WHERE user_id = ?').get(userId).c >= MAX_MERCHANTS) {
    throw new ApiError(400, 'too_many_merchants', `حداکثر ${MAX_MERCHANTS} فروشگاه`);
  }
  const res = q(
    `INSERT INTO merchants (user_id, name, website, webhook_url, webhook_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    cleanName(input.name),
    httpUrl(input.website, 'website'),
    httpUrl(input.webhook_url, 'webhook_url'),
    randomToken('whsec_'),
    Date.now(),
  );
  return getMerchant(userId, Number(res.lastInsertRowid));
}

export function getMerchant(userId, id) {
  const m = q('SELECT * FROM merchants WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!m) throw new ApiError(404, 'merchant_not_found', 'فروشگاه پیدا نشد');
  return m;
}

/** Cards a merchant may receive payments on (active or not). */
export function merchantCards(m) {
  return m.all_cards
    ? q('SELECT * FROM cards WHERE user_id = ? ORDER BY id').all(m.user_id)
    : q(
      `SELECT c.* FROM cards c JOIN merchant_cards mc ON mc.card_id = c.id
       WHERE mc.merchant_id = ? AND c.user_id = ? ORDER BY c.id`,
    ).all(m.id, m.user_id);
}

export function updateMerchant(userId, id, b = {}) {
  const m = getMerchant(userId, id);
  const ttl = !('tx_ttl_sec' in b) ? m.tx_ttl_sec
    : b.tx_ttl_sec == null || b.tx_ttl_sec === '' ? null
    : positiveInt(b.tx_ttl_sec, 'tx_ttl_sec', { min: config.txMinTtlSec, max: config.txMaxTtlSec });
  return tx(() => {
    q(`UPDATE merchants SET name = ?, website = ?, webhook_url = ?, tx_ttl_sec = ?, active = ?, all_cards = ?
       WHERE id = ?`).run(
      'name' in b ? cleanName(b.name) : m.name,
      'website' in b ? httpUrl(b.website, 'website') : m.website,
      'webhook_url' in b ? httpUrl(b.webhook_url, 'webhook_url') : m.webhook_url,
      ttl,
      'active' in b ? (b.active ? 1 : 0) : m.active,
      'all_cards' in b ? (b.all_cards ? 1 : 0) : m.all_cards,
      m.id,
    );
    if (Array.isArray(b.card_ids)) {
      const ids = [...new Set(b.card_ids.map(Number))];
      const owned = new Set(q('SELECT id FROM cards WHERE user_id = ?').all(userId).map((c) => c.id));
      if (ids.some((cid) => !owned.has(cid))) throw new ApiError(400, 'card_not_found', 'کارت نامعتبر است');
      q('DELETE FROM merchant_cards WHERE merchant_id = ?').run(m.id);
      for (const cid of ids) q('INSERT INTO merchant_cards (merchant_id, card_id) VALUES (?, ?)').run(m.id, cid);
    }
    return getMerchant(userId, m.id);
  });
}

export function rotateApiKey(userId, id) {
  const m = getMerchant(userId, id);
  const key = randomToken('pk_live_');
  q('UPDATE merchants SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?').run(sha256(key), key.slice(0, 12), m.id);
  return key;
}

export function rotateWebhookSecret(userId, id) {
  const m = getMerchant(userId, id);
  const secret = randomToken('whsec_');
  q('UPDATE merchants SET webhook_secret = ? WHERE id = ?').run(secret, m.id);
  return secret;
}

/** Delete a merchant; one with transactions is archived instead (key revoked) to keep history. */
export function deleteMerchant(userId, id) {
  const m = getMerchant(userId, id);
  if (q('SELECT 1 FROM transactions WHERE merchant_id = ? LIMIT 1').get(m.id)) {
    q('UPDATE merchants SET active = 0, api_key_hash = NULL, api_key_prefix = NULL WHERE id = ?').run(m.id);
    return { archived: true };
  }
  q('DELETE FROM merchants WHERE id = ?').run(m.id);
  return { archived: false };
}

/** Merchant as shown in the dashboard (secrets included: the owner is logged in). */
export function dashMerchant(m) {
  const stat = q(
    `SELECT COUNT(*) FILTER (WHERE status = 'paid') AS paid,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending,
            COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid_sum
     FROM transactions WHERE merchant_id = ?`,
  ).get(m.id);
  return {
    id: m.id,
    name: m.name,
    website: m.website,
    active: !!m.active,
    api_key_prefix: m.api_key_prefix,
    webhook_url: m.webhook_url,
    webhook_secret: m.webhook_secret,
    tx_ttl_sec: m.tx_ttl_sec,
    all_cards: !!m.all_cards,
    card_ids: merchantCards(m).map((c) => c.id),
    stats: { paid: stat.paid, pending: stat.pending, paid_sum: stat.paid_sum },
    created_at: iso(m.created_at),
  };
}
