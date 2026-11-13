// @paychi/variz — JavaScript client for the Paychi Variz API.
// Zero dependencies. Runs on Node.js 18+, Bun, Deno and edge runtimes (anything with fetch + Web Crypto).
//
// Keep the API key on your server: it can create and cancel transactions for your account.

const DEFAULT_TIMEOUT = 15_000;

/** Error returned by the API (or thrown for network problems / timeouts). */
export class VarizError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, cause?: unknown }} [info]
   */
  constructor(message, { status = 0, code = 'error', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'VarizError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

/** Shared HTTP layer. */
async function request({ baseUrl, token, timeout, fetchImpl }, method, path, { body, query, signal } = {}) {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null && v !== '') url.searchParams.set(k, String(v));

  const timer = AbortSignal.timeout(timeout);
  let combined = timer;
  if (signal) {
    // AbortSignal.any is Node 20.3+; combine by hand for Node 18.
    const ctl = new AbortController();
    const relay = (s) => (s.aborted ? ctl.abort(s.reason) : s.addEventListener('abort', () => ctl.abort(s.reason), { once: true }));
    relay(signal);
    relay(timer);
    combined = ctl.signal;
  }
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      signal: combined,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    if (timer.aborted) throw new VarizError(`Request timed out after ${timeout} ms`, { code: 'timeout', cause: e });
    throw new VarizError(`Network error: ${e?.message ?? e}`, { code: 'network_error', cause: e });
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const err = json?.error;
    throw new VarizError(err?.message || `HTTP ${res.status}`, { status: res.status, code: err?.code || 'http_error' });
  }
  return json;
}

function config(opts, tokenName) {
  if (!opts || typeof opts !== 'object') throw new TypeError('Options object is required');
  const token = opts[tokenName];
  if (!token) throw new TypeError(`${tokenName} is required`);
  if (!opts.baseUrl) throw new TypeError('baseUrl is required (e.g. "https://pay.example.com")');
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('No fetch available: pass options.fetch');
  return { baseUrl: String(opts.baseUrl), token, timeout: opts.timeout ?? DEFAULT_TIMEOUT, fetchImpl };
}

// ------------------------------------------------------------------ merchant client

/**
 * Merchant client: create transactions, check their status, list cards.
 *
 *   const variz = new Variz({ apiKey: process.env.VARIZ_API_KEY, baseUrl: 'https://pay.example.com' });
 *   const tx = await variz.transactions.create({ amount: 1_500_000, order_id: 'INV-1' });
 */
export class Variz {
  constructor(options) {
    const cfg = config(options, 'apiKey');
    const call = (method, path, o) => request(cfg, method, '/api/v1' + path, o);

    this.transactions = {
      /** Create a transaction. `amount` is in Rial; the response `amount` is the unique amount to pay. */
      create: (params, { signal } = {}) => {
        if (!params || params.amount == null) throw new TypeError('amount is required');
        return call('POST', '/transactions', { body: params, signal });
      },
      /** Fetch one transaction by id. */
      get: (id, { signal } = {}) => call('GET', `/transactions/${encodeURIComponent(id)}`, { signal }),
      /** List recent transactions (newest first). */
      list: async (params = {}, { signal } = {}) =>
        (await call('GET', '/transactions', { query: params, signal })).data,
      /** Cancel a pending transaction. */
      cancel: (id, { signal } = {}) => call('POST', `/transactions/${encodeURIComponent(id)}/cancel`, { body: {}, signal }),
      /**
       * Poll until the transaction is no longer pending and return it.
       * For bots / scripts without a public webhook URL. Resolves with status paid, expired or cancelled.
       */
      waitForPayment: async (id, { interval = 3000, timeout, signal } = {}) => {
        const deadline = timeout ? Date.now() + timeout : Infinity;
        // No endless loop: the server itself turns a pending transaction into "expired".
        for (;;) {
          const tx = await call('GET', `/transactions/${encodeURIComponent(id)}`, { signal });
          if (tx.status !== 'pending') return tx;
          if (Date.now() + interval > deadline) {
            throw new VarizError('Timed out waiting for payment', { code: 'timeout' });
          }
          await sleep(interval, signal);
        }
      },
    };

    this.cards = {
      /** Cards this merchant receives payments on, with their daily limit and what is left today. */
      list: async ({ signal } = {}) => (await call('GET', '/cards', { signal })).data,
    };

    this.merchant = {
      /** The merchant this API key belongs to: { id, name, website }. */
      get: async ({ signal } = {}) => call('GET', '/merchant', { signal }),
    };
  }
}

// ------------------------------------------------------------------ device client

/**
 * Listener-device client: build your own listener (script, other app, gateway) instead of the
 * Android app. Get a token with `VarizDevice.pair()` / `VarizDevice.login()`, or create one in the
 * dashboard's API tab.
 */
export class VarizDevice {
  constructor(options) {
    this._cfg = config(options, 'token');
  }

  _call(method, path, o) {
    return request(this._cfg, method, '/api/device' + path, o);
  }

  /** Account info and the optional sender lists. */
  config({ signal } = {}) {
    return this._call('GET', '/config', { signal });
  }

  /**
   * Forward a bank message. Returns { accepted, matched, transaction_id?, reason? }.
   * @param {{ type?: 'sms' | 'notification', sender: string, body: string, received_at?: number }} message
   */
  ingest(message, { signal } = {}) {
    return this._call('POST', '/ingest', { body: { type: 'sms', ...message }, signal });
  }

  /** Revoke this device's token. */
  logout({ signal } = {}) {
    return this._call('POST', '/logout', { body: {}, signal });
  }

  /** Redeem a one-time quick-connect code (or a full /connect#code link) and get a device client. */
  static async pair({ baseUrl, code, deviceName, installId, fetch, timeout } = {}) {
    let base = baseUrl;
    let c = code;
    if (c && /^https?:\/\//.test(c)) {
      const u = new URL(c);
      base = base ?? u.origin;
      c = u.hash.slice(1);
    }
    if (!base || !c) throw new TypeError('baseUrl and code (or a /connect#code link) are required');
    const cfg = { baseUrl: base, token: null, timeout: timeout ?? DEFAULT_TIMEOUT, fetchImpl: fetch ?? globalThis.fetch };
    const res = await request(cfg, 'POST', '/api/device/pair', {
      body: { code: c, device_name: deviceName, install_id: installId, platform: 'other' },
    });
    // `device` is the ready-to-use client; the server's { id, name } for it is in `info`.
    return { ...res, info: res.device, device: new VarizDevice({ baseUrl: base, token: res.token, fetch, timeout }) };
  }

  /** Sign in with the dashboard phone number + password and get a device client. */
  static async login({ baseUrl, phone, password, deviceName, installId, fetch, timeout } = {}) {
    const cfg = { baseUrl, token: null, timeout: timeout ?? DEFAULT_TIMEOUT, fetchImpl: fetch ?? globalThis.fetch };
    const res = await request(cfg, 'POST', '/api/device/login', {
      body: { phone, password, device_name: deviceName, install_id: installId, platform: 'other' },
    });
    return { ...res, info: res.device, device: new VarizDevice({ baseUrl, token: res.token, fetch, timeout }) };
  }
}

// ------------------------------------------------------------------ webhooks

const subtle = async () => (globalThis.crypto?.subtle ?? (await import('node:crypto')).webcrypto.subtle);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toText = (body) =>
  typeof body === 'string' ? body
    : body instanceof ArrayBuffer ? new TextDecoder().decode(body)
    : ArrayBuffer.isView(body) ? new TextDecoder().decode(body)
    : null;

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compute the signature header value for a body (useful for tests). */
export async function signWebhook(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const s = await subtle();
  const key = await s.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await s.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${toText(rawBody)}`));
  return `t=${timestamp},v1=${hex(mac)}`;
}

/**
 * Verify a webhook and return the parsed event. Throws VarizError (code "invalid_signature") if it
 * is not genuine or older than `tolerance` seconds.
 *
 * Pass the RAW request body (string / Buffer / Uint8Array), not a re-serialised JSON object.
 */
export async function verifyWebhook(rawBody, signatureHeader, secret, { tolerance = 300 } = {}) {
  const text = toText(rawBody);
  if (text == null) throw new TypeError('rawBody must be the raw request body (string, Buffer or Uint8Array)');
  if (!secret) throw new TypeError('secret is required');
  const m = /(?:^|,)\s*t=(\d+)\s*,\s*v1=([0-9a-f]{64})/.exec(String(signatureHeader ?? ''));
  if (!m) throw new VarizError('Missing or malformed X-Paychi-Signature header', { status: 400, code: 'invalid_signature' });
  const ts = Number(m[1]);
  if (tolerance && Math.abs(Date.now() / 1000 - ts) > tolerance) {
    throw new VarizError('Webhook timestamp is too old', { status: 400, code: 'invalid_signature' });
  }
  const expected = (await signWebhook(text, secret, ts)).split('v1=')[1];
  if (!safeEqual(expected, m[2])) throw new VarizError('Invalid webhook signature', { status: 400, code: 'invalid_signature' });
  return JSON.parse(text);
}

export default Variz;
