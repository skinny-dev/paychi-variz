import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { q } from '../db.js';

// Delay before retry N (after the Nth failed attempt). 6 attempts in total.
const BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];

export function sign(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Queue a webhook for a transaction event. `data` is the public transaction object. */
export function enqueueWebhook(txRow, event, data) {
  const merchant = q('SELECT id, webhook_url FROM merchants WHERE id = ?').get(txRow.merchant_id);
  const url = txRow.callback_url || merchant?.webhook_url;
  if (!url) return;
  const now = Date.now();
  const payload = JSON.stringify({ event, created_at: new Date(now).toISOString(), data });
  q(
    `INSERT INTO webhook_deliveries (user_id, merchant_id, tx_id, event, url, payload, next_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(txRow.user_id, txRow.merchant_id, txRow.id, event, url, payload, now, now);
  setImmediate(() => processDueWebhooks().catch(() => {}));
}

function isPrivateAddress(ip) {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function assertAllowedTarget(url) {
  if (config.allowPrivateWebhooks) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error('webhook target resolves to a private address');
  }
}

async function deliver(d) {
  // Signed with the merchant's secret at send time, so a rotated secret applies to retries too.
  const secret = q('SELECT webhook_secret FROM merchants WHERE id = ?').get(d.merchant_id)?.webhook_secret
    ?? q('SELECT webhook_secret FROM users WHERE id = ?').get(d.user_id)?.webhook_secret;
  const ts = Math.floor(Date.now() / 1000);
  let code = null;
  let error = null;
  try {
    await assertAllowedTarget(d.url);
    const res = await fetch(d.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Paychi-Webhook/1',
        'x-paychi-event': d.event,
        'x-paychi-delivery': String(d.id),
        'x-paychi-signature': `t=${ts},v1=${sign(secret, ts, d.payload)}`,
      },
      body: d.payload,
    });
    code = res.status;
    if (code < 200 || code >= 300) error = `HTTP ${code}`;
  } catch (e) {
    error = String(e?.cause?.code || e?.message || e).slice(0, 200);
  }

  const attempts = d.attempts + 1;
  if (!error) {
    q(`UPDATE webhook_deliveries SET status = 'ok', attempts = ?, last_code = ?, last_error = NULL WHERE id = ?`)
      .run(attempts, code, d.id);
  } else if (attempts > BACKOFF_MS.length) {
    q(`UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_code = ?, last_error = ? WHERE id = ?`)
      .run(attempts, code, error, d.id);
  } else {
    q(`UPDATE webhook_deliveries SET attempts = ?, last_code = ?, last_error = ?, next_at = ? WHERE id = ?`)
      .run(attempts, code, error, Date.now() + BACKOFF_MS[attempts - 1], d.id);
  }
}

let running = false;
export async function processDueWebhooks() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const due = q(
        `SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 20`,
      ).all(Date.now());
      if (!due.length) break;
      await Promise.all(due.map(deliver));
    }
  } finally {
    running = false;
  }
}
