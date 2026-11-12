// Listener device API.
//   POST /login  — the app signs in with the account's phone + password.
//   POST /pair   — the app redeems a one-time pairing code (QR / link from the dashboard).
//   Both return a device token; everything else needs `Authorization: Bearer dev_...`.
import { q } from '../db.js';
import { requireDevice, verifyPassword } from '../auth.js';
import { normalizeDigits } from '../parser.js';
import { ingestMessage } from '../services/transactions.js';
import { ApiError, randomToken, rateLimit, sha256 } from '../util.js';

const MAX_DEVICES = 20;

/** Create (or, for a known app install, refresh) a device and return its new token. */
function issueDevice(user, b) {
  const name = String(b.device_name ?? '').trim().slice(0, 60) || 'گوشی من';
  const platform = ['android', 'ios', 'other'].includes(b.platform) ? b.platform : 'android';
  const installId = b.install_id ? String(b.install_id).slice(0, 64) : null;
  const token = randomToken('dev_');
  const now = Date.now();

  // The same app install connecting again replaces its old token instead of piling up devices.
  const existing = installId
    ? q('SELECT id FROM devices WHERE user_id = ? AND install_id = ?').get(user.id, installId)
    : null;
  let deviceId;
  if (existing) {
    q('UPDATE devices SET name = ?, platform = ?, token_hash = ?, token_prefix = ?, last_seen_at = ? WHERE id = ?')
      .run(name, platform, sha256(token), token.slice(0, 10), now, existing.id);
    deviceId = existing.id;
  } else {
    if (q('SELECT COUNT(*) AS c FROM devices WHERE user_id = ?').get(user.id).c >= MAX_DEVICES) {
      throw new ApiError(400, 'too_many_devices', `حداکثر ${MAX_DEVICES} دستگاه؛ از داشبورد یکی را حذف کنید`);
    }
    const res = q(
      `INSERT INTO devices (user_id, name, platform, token_hash, token_prefix, install_id, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(user.id, name, platform, sha256(token), token.slice(0, 10), installId, now, now);
    deviceId = Number(res.lastInsertRowid);
  }
  return { token, device: { id: deviceId, name }, account: { name: user.name, phone: user.phone } };
}

export default async function deviceRoutes(app) {
  app.post('/login', async (req) => {
    const b = req.body ?? {};
    const phone = normalizeDigits(b.phone ?? '').replace(/\s|-/g, '').replace(/^(\+98|0098)/, '0');
    rateLimit('applogin:' + req.ip, 20, 600_000);
    rateLimit('applogin:' + phone, 10, 600_000);
    const user = q('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user || !verifyPassword(String(b.password ?? ''), user.password_hash)) {
      throw new ApiError(401, 'bad_credentials', 'شماره موبایل یا رمز عبور اشتباه است');
    }
    return issueDevice(user, b);
  });

  app.post('/pair', async (req) => {
    const b = req.body ?? {};
    rateLimit('pair:' + req.ip, 30, 600_000);
    // Single use: the row is deleted as it is read.
    const row = q('DELETE FROM pairing_codes WHERE code_hash = ? RETURNING user_id, expires_at')
      .get(sha256(String(b.code ?? '')));
    if (!row || row.expires_at < Date.now()) {
      throw new ApiError(401, 'invalid_pairing_code', 'کد اتصال نامعتبر یا منقضی است؛ از داشبورد کد جدید بگیرید');
    }
    return issueDevice(q('SELECT * FROM users WHERE id = ?').get(row.user_id), b);
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireDevice);
    r.addHook('preHandler', async (req) => rateLimit('dev:' + req.device.id, 300, 60_000));

    /**
     * Both SMS and notifications are listened to by default. An empty list means "any sender";
     * the device then forwards only messages that look like a bank deposit. A non-empty list
     * restricts that type to the listed senders.
     */
    r.get('/config', async (req) => {
      const rows = q('SELECT type, value FROM sources WHERE user_id = ? AND enabled = 1').all(req.user.id);
      return {
        device: { id: req.device.id, name: req.device.name },
        account: { name: req.user.name, phone: req.user.phone },
        sms_senders: rows.filter((s) => s.type === 'sms').map((s) => s.value),
        notification_packages: rows.filter((s) => s.type === 'notification').map((s) => s.value),
      };
    });

    /** Body: { type: "sms" | "notification", sender, body, received_at? } */
    r.post('/ingest', async (req) => ingestMessage(req.user, req.device, req.body));

    r.post('/ping', async () => ({ ok: true, time: new Date().toISOString() }));

    /** Sign this device out: its token stops working. */
    r.post('/logout', async (req) => {
      q('DELETE FROM devices WHERE id = ?').run(req.device.id);
      return { ok: true };
    });
  });
}
