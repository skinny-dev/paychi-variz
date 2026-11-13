import QRCode from 'qrcode';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { config, planById, plans } from '../config.js';
import { q } from '../db.js';
import {
  activeSubscription, createSession, destroySession, hashPassword,
  requireSubscription, requireUser, verifyPassword,
} from '../auth.js';
import { bankCodeOf, bankInfo, clientBankTable, luhnValid } from '../banks.js';
import { normalizeDigits } from '../parser.js';
import { confirmEvent, createTransaction, publicCard, publicTx } from '../services/transactions.js';
import { ApiError, iso, positiveInt, randomToken, rateLimit, sha256 } from '../util.js';
import { createLink, dashLink, deleteLink, updateLink } from '../services/links.js';
import { createConnectCode, deleteChannel, listChannels, telegramStatus, testChannel } from '../services/telegram.js';
import {
  createMerchant, dashMerchant, deleteMerchant, getMerchant, rotateApiKey, rotateWebhookSecret, updateMerchant,
} from '../services/merchants.js';

const apkPath = fileURLToPath(new URL('../../public/downloads/paychi-listener.apk', import.meta.url));

const cleanPhone = (v) => {
  const p = normalizeDigits(v ?? '').replace(/\s|-/g, '').replace(/^(\+98|0098)/, '0');
  if (!/^09\d{9}$/.test(p)) throw new ApiError(400, 'invalid_phone', 'شماره موبایل معتبر نیست');
  return p;
};
const cleanPassword = (v) => {
  if (typeof v !== 'string' || v.length < 8 || v.length > 200) {
    throw new ApiError(400, 'invalid_password', 'رمز عبور باید حداقل ۸ کاراکتر باشد');
  }
  return v;
};
/** Optional account number on a card, used to recognise SMS that name the account instead of the card. */
const cleanAccount = (v) => {
  const d = normalizeDigits(v ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length < 6 || d.length > 26) throw new ApiError(400, 'invalid_account', 'شماره حساب باید ۶ تا ۲۶ رقم باشد');
  return d;
};
const optLimit = (v) =>
  v == null || v === '' ? null : positiveInt(v, 'limit', { min: config.minAmount, max: 100_000_000_000 });

function setSession(reply, userId) {
  const { token, maxAge } = createSession(userId);
  reply.setCookie('sid', token, {
    path: '/', httpOnly: true, sameSite: 'lax', maxAge,
    secure: config.baseUrl.startsWith('https://'),
  });
}

const listMerchants = (uid) =>
  q('SELECT * FROM merchants WHERE user_id = ? ORDER BY active DESC, id').all(uid).map(dashMerchant);

function mePayload(user) {
  const sub = activeSubscription(user.id);
  const count = (sql, ...a) => q(sql).get(...a).c;
  return {
    user: { id: user.id, phone: user.phone, name: user.name },
    subscription: sub && {
      plan: sub.plan,
      starts_at: iso(sub.starts_at),
      expires_at: sub.expires_at ? iso(sub.expires_at) : null,
      tx_used: count('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND created_at >= ?', user.id, sub.starts_at),
    },
    settings: {
      default_card_limit: user.default_card_limit,
    },
    merchants: listMerchants(user.id),
    defaults: {
      card_limit: config.defaultCardLimit,
      tx_ttl_sec: config.txTtlSec,
      tx_min_ttl_sec: config.txMinTtlSec,
      tx_max_ttl_sec: config.txMaxTtlSec,
      min_amount: config.minAmount,
    },
    counts: {
      cards: count('SELECT COUNT(*) AS c FROM cards WHERE user_id = ?', user.id),
      // A device counts once it has actually connected (a manual token nobody used yet does not).
      devices: count('SELECT COUNT(*) AS c FROM devices WHERE user_id = ? AND last_seen_at IS NOT NULL', user.id),
      sources: count('SELECT COUNT(*) AS c FROM sources WHERE user_id = ? AND enabled = 1', user.id),
      paid: count(`SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND status = 'paid'`, user.id),
      pending: count(`SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND status = 'pending'`, user.id),
      paid_sum: q(`SELECT COALESCE(SUM(amount), 0) AS c FROM transactions WHERE user_id = ? AND status = 'paid'`).get(user.id).c,
    },
    base_url: config.baseUrl,
    billing_mode: config.billingMode,
    apk_available: existsSync(apkPath) || Boolean(config.apkUrl),
  };
}

export default async function dashboardRoutes(app) {
  // ---------- public ----------
  app.get('/banks', async () => clientBankTable);
  app.get('/plans', async () => ({ plans, billing_mode: config.billingMode }));
  app.get('/signup-info', async () => ({ code_required: Boolean(config.signupCode) }));

  app.post('/register', async (req, reply) => {
    rateLimit('reg:' + req.ip, 10, 3600_000);
    const phone = cleanPhone(req.body?.phone);
    const password = cleanPassword(req.body?.password);
    const name = String(req.body?.name ?? '').trim().slice(0, 80) || null;
    if (config.signupCode && String(req.body?.signup_code ?? '').trim() !== config.signupCode) {
      throw new ApiError(403, 'invalid_signup_code', 'کد دعوت نادرست است');
    }
    if (q('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
      throw new ApiError(409, 'phone_taken', 'این شماره قبلاً ثبت شده است');
    }
    const res = q(
      'INSERT INTO users (phone, name, password_hash, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(phone, name, hashPassword(password), randomToken('whsec_'), Date.now());
    const userId = Number(res.lastInsertRowid);
    createMerchant(userId, { name: 'فروشگاه اصلی' }); // ready to use; rename or add more later
    setSession(reply, userId);
    return { ok: true };
  });

  app.post('/login', async (req, reply) => {
    rateLimit('login:' + req.ip, 20, 600_000);
    const phone = cleanPhone(req.body?.phone);
    rateLimit('login:' + phone, 10, 600_000);
    const user = q('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user || !verifyPassword(String(req.body?.password ?? ''), user.password_hash)) {
      throw new ApiError(401, 'bad_credentials', 'شماره موبایل یا رمز عبور اشتباه است');
    }
    setSession(reply, user.id);
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    destroySession(req.cookies?.sid);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  // ---------- authenticated ----------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/me', async (req) => mePayload(req.user));

    r.post('/subscribe', async (req) => {
      const plan = planById(req.body?.plan_id);
      if (!plan) throw new ApiError(400, 'invalid_plan', 'پلن نامعتبر است');
      if (config.billingMode === 'off') {
        throw new ApiError(400, 'billing_off', 'در این نسخه اشتراک لازم نیست');
      }
      if (config.billingMode !== 'mock') {
        throw new ApiError(501, 'billing_not_configured', 'پرداخت اشتراک هنوز پیکربندی نشده است');
      }
      const now = Date.now();
      q('INSERT INTO subscriptions (user_id, plan_id, starts_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, plan.id, now, now + plan.days * 86_400_000, now);
      return mePayload(req.user);
    });

    // Account-wide settings. API key, webhook and payment window are per merchant.
    r.patch('/settings', async (req) => {
      const b = req.body ?? {};
      const u = req.user;
      const limit = 'default_card_limit' in b ? optLimit(b.default_card_limit) : u.default_card_limit;
      q('UPDATE users SET default_card_limit = ? WHERE id = ?').run(limit, u.id);
      return mePayload(q('SELECT * FROM users WHERE id = ?').get(u.id));
    });

    // ----- merchants -----
    r.get('/merchants', async (req) => ({ merchants: listMerchants(req.user.id) }));
    r.post('/merchants', async (req) => ({ merchant: dashMerchant(createMerchant(req.user.id, req.body ?? {})) }));
    r.get('/merchants/:id', async (req) => ({ merchant: dashMerchant(getMerchant(req.user.id, req.params.id)) }));
    r.patch('/merchants/:id', async (req) =>
      ({ merchant: dashMerchant(updateMerchant(req.user.id, req.params.id, req.body ?? {})) }));
    r.delete('/merchants/:id', async (req) => deleteMerchant(req.user.id, req.params.id));
    r.post('/merchants/:id/api-key', async (req) => ({ api_key: rotateApiKey(req.user.id, req.params.id) }));
    r.post('/merchants/:id/webhook-secret', async (req) =>
      ({ webhook_secret: rotateWebhookSecret(req.user.id, req.params.id) }));

    // ----- payment links (per merchant) -----
    const linksOf = async (mid) =>
      Promise.all(q('SELECT * FROM payment_links WHERE merchant_id = ? ORDER BY active DESC, id DESC').all(mid).map(dashLink));
    r.get('/merchants/:id/links', async (req) =>
      ({ links: await linksOf(getMerchant(req.user.id, req.params.id).id) }));
    r.post('/merchants/:id/links', async (req) => {
      const l = createLink(req.user.id, req.params.id, req.body ?? {});
      return { link: await dashLink(l), links: await linksOf(l.merchant_id) };
    });
    r.patch('/links/:id', async (req) => {
      const l = updateLink(req.user.id, req.params.id, req.body ?? {});
      return { links: await linksOf(l.merchant_id) };
    });
    r.delete('/links/:id', async (req) => deleteLink(req.user.id, req.params.id));

    // ----- Telegram alerts (per merchant) -----
    r.get('/merchants/:id/telegram', async (req) => {
      const m = getMerchant(req.user.id, req.params.id);
      return { ...telegramStatus(), channels: listChannels(req.user.id, m.id) };
    });
    r.post('/merchants/:id/telegram/connect', async (req) =>
      createConnectCode(req.user.id, getMerchant(req.user.id, req.params.id).id));
    r.post('/telegram/:id/test', async (req) => testChannel(req.user.id, req.params.id));
    r.delete('/telegram/:id', async (req) => {
      deleteChannel(req.user.id, req.params.id);
      return { ok: true };
    });

    // ----- cards -----
    const listCards = (user) =>
      q('SELECT * FROM cards WHERE user_id = ? ORDER BY id').all(user.id).map((c) => publicCard(c, user));

    r.get('/cards', async (req) => ({ cards: listCards(req.user) }));

    r.post('/cards', async (req) => {
      const sub = requireSubscription(req.user.id);
      const number = normalizeDigits(req.body?.number ?? '').replace(/\D/g, '');
      if (!luhnValid(number)) throw new ApiError(400, 'invalid_card', 'شماره کارت معتبر نیست');
      const have = q('SELECT COUNT(*) AS c FROM cards WHERE user_id = ?').get(req.user.id).c;
      if (have >= sub.plan.maxCards) {
        throw new ApiError(402, 'plan_limit_reached', `پلن شما حداکثر ${sub.plan.maxCards} کارت را پشتیبانی می‌کند`);
      }
      if (q('SELECT 1 FROM cards WHERE user_id = ? AND number = ?').get(req.user.id, number)) {
        throw new ApiError(409, 'card_exists', 'این کارت قبلاً ثبت شده است');
      }
      q(`INSERT INTO cards (user_id, number, bank_code, holder_name, daily_limit, account_number, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          req.user.id, number, bankCodeOf(number),
          String(req.body?.holder_name ?? '').trim().slice(0, 80) || null,
          optLimit(req.body?.daily_limit), cleanAccount(req.body?.account_number), Date.now(),
        );
      return { cards: listCards(req.user) };
    });

    r.patch('/cards/:id', async (req) => {
      const card = q('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
      if (!card) throw new ApiError(404, 'not_found', 'کارت پیدا نشد');
      const b = req.body ?? {};
      q('UPDATE cards SET daily_limit = ?, active = ?, holder_name = ?, account_number = ? WHERE id = ?').run(
        'daily_limit' in b ? optLimit(b.daily_limit) : card.daily_limit,
        'active' in b ? (b.active ? 1 : 0) : card.active,
        'holder_name' in b ? String(b.holder_name ?? '').trim().slice(0, 80) || null : card.holder_name,
        'account_number' in b ? cleanAccount(b.account_number) : card.account_number,
        card.id,
      );
      return { cards: listCards(req.user) };
    });

    r.delete('/cards/:id', async (req) => {
      const card = q('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
      if (!card) throw new ApiError(404, 'not_found', 'کارت پیدا نشد');
      if (q('SELECT 1 FROM transactions WHERE card_id = ? LIMIT 1').get(card.id)) {
        // Keep history intact: cards with transactions are only deactivated.
        q('UPDATE cards SET active = 0 WHERE id = ?').run(card.id);
        return { cards: listCards(req.user), deactivated: true };
      }
      q('DELETE FROM cards WHERE id = ?').run(card.id);
      return { cards: listCards(req.user) };
    });

    // ----- listener devices -----
    const listDevices = (uid) =>
      q('SELECT id, name, platform, token_prefix, last_seen_at, created_at FROM devices WHERE user_id = ? ORDER BY id')
        .all(uid)
        .map((d) => ({ ...d, last_seen_at: iso(d.last_seen_at), created_at: iso(d.created_at) }));

    r.get('/devices', async (req) => ({ devices: listDevices(req.user.id) }));

    r.post('/devices', async (req) => {
      const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'گوشی من';
      const platform = ['android', 'ios', 'other'].includes(req.body?.platform) ? req.body.platform : 'android';
      if (q('SELECT COUNT(*) AS c FROM devices WHERE user_id = ?').get(req.user.id).c >= 20) {
        throw new ApiError(400, 'too_many_devices', 'حداکثر ۲۰ دستگاه');
      }
      const token = randomToken('dev_');
      q('INSERT INTO devices (user_id, name, platform, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.user.id, name, platform, sha256(token), token.slice(0, 10), Date.now());
      return { token, devices: listDevices(req.user.id) };
    });

    /**
     * Quick connect: a one-time code (10 minutes) wrapped in a link and a QR of that link.
     * `origin` is the address the dashboard is open on, so the link works wherever the user reached us.
     */
    r.post('/pairing', async (req) => {
      rateLimit('pairing:' + req.user.id, 30, 600_000);
      let origin = config.baseUrl;
      try {
        const u = new URL(String(req.body?.origin ?? ''));
        if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
      } catch { /* keep the configured base URL */ }
      // A phone cannot reach "localhost" (that is the phone itself). When the dashboard is open on
      // this machine, point the link at this machine's address on the local network instead.
      const o = new URL(origin);
      if (['localhost', '127.0.0.1', '[::1]'].includes(o.hostname)) {
        const lan = Object.values(networkInterfaces()).flat()
          .find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
        if (lan) origin = `${o.protocol}//${lan.address}${o.port ? ':' + o.port : ''}`;
      }
      const code = randomToken('', 18);
      const expiresAt = Date.now() + 600_000;
      q('DELETE FROM pairing_codes WHERE user_id = ?').run(req.user.id); // only the newest code is valid
      q('INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(sha256(code), req.user.id, expiresAt);
      // The code sits in the URL fragment, so it is never sent to the server in a page request.
      const url = `${origin}/connect#${code}`;
      return {
        url,
        qr_svg: await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }),
        expires_at: iso(expiresAt),
      };
    });

    r.delete('/devices/:id', async (req) => {
      q('DELETE FROM devices WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
      return { devices: listDevices(req.user.id) };
    });

    // ----- listening sources -----
    const listSources = (uid) =>
      q('SELECT id, type, value, label, enabled FROM sources WHERE user_id = ? ORDER BY id').all(uid)
        .map((s) => ({ ...s, enabled: !!s.enabled }));

    r.get('/sources', async (req) => ({ sources: listSources(req.user.id) }));

    r.post('/sources', async (req) => {
      const type = req.body?.type === 'notification' ? 'notification' : 'sms';
      const value = String(req.body?.value ?? '').trim().slice(0, 120);
      if (!value) throw new ApiError(400, 'invalid_source', 'مقدار منبع را وارد کنید');
      if (q('SELECT COUNT(*) AS c FROM sources WHERE user_id = ?').get(req.user.id).c >= 100) {
        throw new ApiError(400, 'too_many_sources', 'حداکثر ۱۰۰ منبع');
      }
      q('INSERT OR IGNORE INTO sources (user_id, type, value, label, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, type, value, String(req.body?.label ?? '').trim().slice(0, 80) || null, Date.now());
      return { sources: listSources(req.user.id) };
    });

    r.patch('/sources/:id', async (req) => {
      q('UPDATE sources SET enabled = ? WHERE id = ? AND user_id = ?')
        .run(req.body?.enabled ? 1 : 0, req.params.id, req.user.id);
      return { sources: listSources(req.user.id) };
    });

    r.delete('/sources/:id', async (req) => {
      q('DELETE FROM sources WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
      return { sources: listSources(req.user.id) };
    });

    // ----- transactions & incoming messages -----
    r.get('/transactions', async (req) => {
      const where = ['user_id = ?'];
      const args = [req.user.id];
      if (['pending', 'paid', 'expired', 'cancelled'].includes(req.query.status)) {
        where.push('status = ?');
        args.push(req.query.status);
      }
      if (req.query.merchant_id) {
        where.push('merchant_id = ?');
        args.push(Number(req.query.merchant_id));
      }
      const rows = q(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`).all(...args);
      return { transactions: rows.map(publicTx) };
    });

    // Test transaction from the dashboard (same as the API call of that merchant).
    r.post('/transactions', async (req) => {
      const { merchant_id: mid, ...input } = req.body ?? {};
      const merchant = mid
        ? getMerchant(req.user.id, mid)
        : q('SELECT * FROM merchants WHERE user_id = ? AND active = 1 ORDER BY id LIMIT 1').get(req.user.id);
      if (!merchant) throw new ApiError(422, 'no_merchant', 'ابتدا یک فروشگاه بسازید');
      return publicTx(createTransaction(req.user, merchant, input));
    });

    r.get('/events', async (req) => ({
      events: q(
        `SELECT e.id, e.type, e.sender, e.body, e.amount, e.is_deposit, e.tx_id, e.received_at, e.bank_code, e.result,
                e.card_id, c.number AS card_number
         FROM events e LEFT JOIN cards c ON c.id = e.card_id
         WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 50`,
      ).all(req.user.id).map((e) => ({
        ...e,
        is_deposit: !!e.is_deposit,
        bank_name: e.bank_code ? bankInfo(e.bank_code).name : null,
        card_last4: e.card_number ? e.card_number.slice(-4) : null,
        card_number: undefined,
        received_at: iso(e.received_at),
      })),
    }));

    // Confirm a message by hand (e.g. the money reached another of your cards).
    r.post('/events/:id/confirm', async (req) =>
      publicTx(confirmEvent(req.user, Number(req.params.id), req.body?.transaction_id || null)));

    // ----- which bank each SMS sender / app belongs to (learned automatically, editable) -----
    const listSenderBanks = (uid) =>
      q('SELECT id, type, sender, bank_code, auto FROM sender_banks WHERE user_id = ? ORDER BY type, sender').all(uid)
        .map((s) => ({ ...s, auto: !!s.auto, bank_name: bankInfo(s.bank_code).name }));

    r.get('/sender-banks', async (req) => ({ sender_banks: listSenderBanks(req.user.id), banks: clientBankTable.banks }));

    r.post('/sender-banks', async (req) => {
      const type = req.body?.type === 'notification' ? 'notification' : 'sms';
      const sender = String(req.body?.sender ?? '').trim().toLowerCase().slice(0, 120);
      const bank = String(req.body?.bank_code ?? '');
      if (!sender) throw new ApiError(400, 'invalid_sender', 'فرستنده را وارد کنید');
      if (!clientBankTable.banks[bank] || bank === 'unknown') throw new ApiError(400, 'invalid_bank', 'بانک نامعتبر است');
      q(`INSERT INTO sender_banks (user_id, type, sender, bank_code, auto, created_at) VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT (user_id, type, sender) DO UPDATE SET bank_code = excluded.bank_code, auto = 0`)
        .run(req.user.id, type, sender, bank, Date.now());
      return { sender_banks: listSenderBanks(req.user.id) };
    });

    r.delete('/sender-banks/:id', async (req) => {
      q('DELETE FROM sender_banks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
      return { sender_banks: listSenderBanks(req.user.id) };
    });

    r.get('/webhooks', async (req) => ({
      deliveries: q(
        `SELECT d.id, d.tx_id, d.event, d.url, d.attempts, d.status, d.last_code, d.last_error, d.created_at,
                d.merchant_id, m.name AS merchant_name
         FROM webhook_deliveries d LEFT JOIN merchants m ON m.id = d.merchant_id
         WHERE d.user_id = ? AND (? IS NULL OR d.merchant_id = ?) ORDER BY d.id DESC LIMIT 50`,
      ).all(req.user.id, req.query.merchant_id ? Number(req.query.merchant_id) : null,
        req.query.merchant_id ? Number(req.query.merchant_id) : null)
        .map((d) => ({ ...d, created_at: iso(d.created_at) })),
    }));
  });
}
