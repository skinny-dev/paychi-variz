// Telegram payment alerts. One bot for the whole server (TELEGRAM_BOT_TOKEN). A merchant owner
// connects a chat with one tap: the dashboard opens t.me/<bot>?start=<code>, the bot sees the code
// (long polling, no public webhook needed) and remembers the chat for that merchant.
// TELEGRAM_API_BASE can point at a relay / proxy when the server cannot reach api.telegram.org.
import { config } from '../config.js';
import { q } from '../db.js';
import { bankInfo } from '../banks.js';
import { ApiError, iso, randomToken, sha256 } from '../util.js';

const CODE_TTL_MS = 15 * 60_000;
let botUsername = null;
let stopped = false;

const enabled = () => Boolean(config.telegramToken);

async function tg(method, body, { timeoutMs = 15_000 } = {}) {
  const res = await fetch(`${config.telegramApiBase}/bot${config.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.description || `HTTP ${res.status}`);
  return json.result;
}

export const telegramStatus = () => ({ enabled: enabled(), bot: botUsername });

/** One-time code (15 min) + deep link that connects a Telegram chat to a merchant's alerts. */
export function createConnectCode(userId, merchantId) {
  if (!enabled()) throw new ApiError(501, 'telegram_disabled', 'ربات تلگرام روی سرور تنظیم نشده است (TELEGRAM_BOT_TOKEN)');
  const code = randomToken('', 12); // base64url: valid in a t.me start parameter
  const expiresAt = Date.now() + CODE_TTL_MS;
  q('DELETE FROM notify_codes WHERE user_id = ? AND merchant_id IS ?').run(userId, merchantId);
  q('INSERT INTO notify_codes (code_hash, user_id, merchant_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(code), userId, merchantId, expiresAt);
  return {
    code,
    bot: botUsername,
    link: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
    expires_at: iso(expiresAt),
  };
}

export const listChannels = (userId, merchantId) =>
  q('SELECT id, chat_id, title, last_error, created_at FROM notify_channels WHERE user_id = ? AND merchant_id IS ? ORDER BY id')
    .all(userId, merchantId).map((c) => ({ ...c, created_at: iso(c.created_at) }));

export function deleteChannel(userId, id) {
  q('DELETE FROM notify_channels WHERE id = ? AND user_id = ?').run(Number(id), userId);
}

async function send(channel, text) {
  try {
    await tg('sendMessage', { chat_id: channel.chat_id, text });
    if (channel.last_error) q('UPDATE notify_channels SET last_error = NULL WHERE id = ?').run(channel.id);
    return true;
  } catch (e) {
    q('UPDATE notify_channels SET last_error = ? WHERE id = ?').run(String(e.message).slice(0, 200), channel.id);
    return false;
  }
}

export async function testChannel(userId, id) {
  const ch = q('SELECT * FROM notify_channels WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!ch) throw new ApiError(404, 'not_found', 'گفتگو پیدا نشد');
  if (!(await send(ch, '🔔 پیام آزمایشی پی‌چی واریز — اعلان‌ها به این گفتگو می‌رسد.'))) {
    throw new ApiError(502, 'telegram_failed', 'ارسال به تلگرام ناموفق بود: ' + q('SELECT last_error FROM notify_channels WHERE id = ?').get(ch.id).last_error);
  }
  return { ok: true };
}

const fa = (n) => Number(n).toLocaleString('fa-IR');

function channelsFor(t) {
  return q('SELECT * FROM notify_channels WHERE user_id = ? AND (merchant_id IS NULL OR merchant_id = ?)')
    .all(t.user_id, t.merchant_id);
}

function txLines(t) {
  const m = q('SELECT name FROM merchants WHERE id = ?').get(t.merchant_id);
  const card = q('SELECT number, bank_code FROM cards WHERE id = ?').get(t.card_id);
  const meta = t.metadata ? JSON.parse(t.metadata) : {};
  return [
    `فروشگاه: ${m?.name ?? '—'}`,
    `مبلغ: ${fa(t.amount)} ریال`,
    t.description ? `بابت: ${t.description}` : null,
    t.order_id ? `سفارش: ${t.order_id}` : null,
    meta.payer_name ? `پرداخت‌کننده: ${meta.payer_name} — ${meta.payer_phone ?? ''}` : null,
    card ? `کارت: ${bankInfo(card.bank_code).name} ${card.number.slice(-4)}` : null,
    `شناسه: ${t.id}`,
  ].filter(Boolean);
}

/** Fire-and-forget alert when a transaction is paid. */
export function notifyPaid(t) {
  if (!enabled()) return;
  const chans = channelsFor(t);
  if (!chans.length) return;
  const text = ['✅ پرداخت دریافت شد', ...txLines(t)].join('\n');
  for (const ch of chans) send(ch, text).catch(() => {});
}

/** Alert when a deposit with the right amount was held back (other card / bank): needs a manual confirm. */
export function notifyHeld(t, reason) {
  if (!enabled()) return;
  const chans = channelsFor(t);
  if (!chans.length) return;
  const why = reason === 'card_mismatch' ? 'به کارت دیگری واریز شده' : 'پیامک از بانک دیگری است';
  const text = [`⚠️ واریز با مبلغ تراکنش رسید ولی ${why}؛ خودکار تأیید نشد.`, ...txLines(t),
    `برای تأیید: داشبورد ← دستگاه‌ها ← آخرین پیام‌ها ← «تأیید دستی»`].join('\n');
  for (const ch of chans) send(ch, text).catch(() => {});
}

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg?.chat || typeof msg.text !== 'string') return;
  const chatId = String(msg.chat.id);
  const m = /^\/start(?:@\w+)?\s+([\w-]{8,64})\s*$/.exec(msg.text.trim()) || /^([\w-]{16})$/.exec(msg.text.trim());
  if (!m) {
    if (msg.text.startsWith('/start')) {
      await tg('sendMessage', { chat_id: chatId, text: 'سلام! برای دریافت اعلان پرداخت، از داشبورد پی‌چی واریز دکمه «اتصال تلگرام» را بزنید.' });
    }
    return;
  }
  const row = q('SELECT * FROM notify_codes WHERE code_hash = ? AND expires_at > ?').get(sha256(m[1]), Date.now());
  if (!row) {
    await tg('sendMessage', { chat_id: chatId, text: 'این کد معتبر نیست یا منقضی شده است. از داشبورد دوباره «اتصال تلگرام» را بزنید.' });
    return;
  }
  q('DELETE FROM notify_codes WHERE code_hash = ?').run(row.code_hash);
  const exists = q('SELECT 1 FROM notify_channels WHERE user_id = ? AND merchant_id IS ? AND chat_id = ?')
    .get(row.user_id, row.merchant_id, chatId);
  const title = msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || null;
  if (!exists) {
    q('INSERT INTO notify_channels (user_id, merchant_id, chat_id, title, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.user_id, row.merchant_id, chatId, title, Date.now());
  }
  const name = row.merchant_id ? q('SELECT name FROM merchants WHERE id = ?').get(row.merchant_id)?.name : 'همه فروشگاه‌ها';
  await tg('sendMessage', { chat_id: chatId, text: `✅ وصل شد. اعلان پرداخت‌های «${name}» به این گفتگو ارسال می‌شود.` });
}

/** Long-poll getUpdates forever (no-op without a token). */
export async function startTelegram() {
  if (!enabled()) return;
  let offset = 0;
  let backoff = 1000;
  while (!stopped) {
    try {
      if (!botUsername) botUsername = (await tg('getMe')).username;
      const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, { timeoutMs: 35_000 });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((e) => console.error('telegram update failed:', e.message));
      }
      backoff = 1000;
    } catch (e) {
      if (stopped) break;
      console.error('telegram polling failed:', e.message);
      await new Promise((r) => setTimeout(r, backoff).unref());
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

export function stopTelegram() {
  stopped = true;
}
