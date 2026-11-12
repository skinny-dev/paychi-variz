import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { q } from './db.js';
import { planById } from './config.js';
import { ApiError, randomToken, sha256 } from './util.js';

const SESSION_MS = 30 * 86_400_000;

export function hashPassword(password) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex');
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function createSession(userId) {
  const token = randomToken('', 32);
  q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    Date.now() + SESSION_MS,
  );
  return { token, maxAge: SESSION_MS / 1000 };
}

export function destroySession(token) {
  if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/** preHandler: dashboard session cookie. */
export async function requireUser(req) {
  const token = req.cookies?.sid;
  const row =
    token &&
    q(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    ).get(sha256(token), Date.now());
  if (!row) throw new ApiError(401, 'unauthenticated', 'Login required');
  req.user = row;
}

/** preHandler: merchant API key (Authorization: Bearer pk_...). */
export async function requireApiKey(req) {
  const key = bearer(req) || req.headers['x-api-key'];
  const row = key && q('SELECT * FROM users WHERE api_key_hash = ?').get(sha256(String(key)));
  if (!row) throw new ApiError(401, 'invalid_api_key', 'Missing or invalid API key');
  req.user = row;
}

/** preHandler: listener device token (Authorization: Bearer dev_...). */
export async function requireDevice(req) {
  const token = bearer(req);
  const device = token && q('SELECT * FROM devices WHERE token_hash = ?').get(sha256(token));
  if (!device) throw new ApiError(401, 'invalid_device_token', 'Missing or invalid device token');
  q('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), device.id);
  req.device = device;
  req.user = q('SELECT * FROM users WHERE id = ?').get(device.user_id);
}

/** Active subscription (with its plan) or null. */
export function activeSubscription(userId) {
  const sub = q(
    'SELECT * FROM subscriptions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1',
  ).get(userId, Date.now());
  if (!sub) return null;
  const plan = planById(sub.plan_id);
  return plan ? { ...sub, plan } : null;
}

export function requireSubscription(userId) {
  const sub = activeSubscription(userId);
  if (!sub) throw new ApiError(402, 'subscription_required', 'An active subscription is required');
  return sub;
}
