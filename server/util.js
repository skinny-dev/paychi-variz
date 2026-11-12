import { createHash, randomBytes } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (prefix, bytes = 24) => prefix + randomBytes(bytes).toString('base64url');
export const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** Start of the current day in Tehran (UTC+03:30, no DST since 2022), as epoch ms. */
export function tehranDayStart(nowMs = Date.now()) {
  const offset = 3.5 * 3600_000;
  return Math.floor((nowMs + offset) / 86_400_000) * 86_400_000 - offset;
}

export function httpUrl(value, field) {
  if (value == null || value === '') return null;
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new ApiError(400, 'invalid_url', `${field} is not a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ApiError(400, 'invalid_url', `${field} must be http or https`);
  }
  return u.toString();
}

export function positiveInt(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ApiError(400, 'invalid_' + field, `${field} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** Tiny fixed-window in-memory rate limiter. */
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) {
    b = { count: 0, reset: t + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) throw new ApiError(429, 'rate_limited', 'Too many requests, try again later');
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
}
