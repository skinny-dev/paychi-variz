import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { db, q } from './db.js';
import { ApiError } from './util.js';
import dashboardRoutes from './routes/dashboard.js';
import apiRoutes from './routes/api.js';
import deviceRoutes from './routes/device.js';
import payRoutes from './routes/pay.js';
import compatRoutes from './routes/compat.js';
import { expireTransactions } from './services/transactions.js';
import { processDueWebhooks } from './services/webhooks.js';
import { startTelegram, stopTelegram } from './services/telegram.js';

if (config.production) {
  if (!config.baseUrl.startsWith('https://')) {
    console.warn(`WARNING: BASE_URL is ${config.baseUrl}. Use the public https:// address in production (payment links, QR, secure cookies).`);
  }
  if (config.billingMode !== 'live' && !config.signupCode) {
    console.warn(`WARNING: BILLING_MODE=${config.billingMode} and no SIGNUP_CODE — anyone can sign up and use it for free.`);
  }
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' }, trustProxy: true, bodyLimit: 64 * 1024 });

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ApiError) {
    return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
  }
  if (err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
  }
  req.log.error(err);
  return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
});

app.addHook('onSend', async (req, reply) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
});

await app.register(cookie);
await app.register(fastifyStatic, { root: fileURLToPath(new URL('../public', import.meta.url)) });

app.get('/dashboard', (req, reply) => reply.sendFile('app.html'));
app.get('/pay/:id', (req, reply) => reply.sendFile('pay.html'));
app.get('/connect', (req, reply) => reply.sendFile('connect.html'));
app.get('/l/:slug', (req, reply) => reply.sendFile('link.html'));
app.get('/healthz', async () => {
  q('SELECT 1').get();
  return { ok: true };
});
// The APK is either inside public/downloads (served as a file) or hosted elsewhere (APK_URL).
const apkFile = fileURLToPath(new URL('../public/downloads/paychi-listener.apk', import.meta.url));
app.get('/downloads/paychi-listener.apk', (req, reply) => {
  if (existsSync(apkFile)) return reply.sendFile('downloads/paychi-listener.apk');
  if (config.apkUrl) return reply.redirect(config.apkUrl);
  return reply.code(404).send({ error: { code: 'not_found', message: 'APK not available' } });
});

await app.register(dashboardRoutes, { prefix: '/api/dash' });
await app.register(apiRoutes, { prefix: '/api/v1' });
await app.register(deviceRoutes, { prefix: '/api/device' });
await app.register(payRoutes, { prefix: '/api/pay' });
await app.register(compatRoutes, { prefix: '/api/compat' });

// Background workers.
const tick = (fn, ms) =>
  setInterval(() => {
    try {
      Promise.resolve(fn()).catch((e) => app.log.error(e));
    } catch (e) {
      app.log.error(e);
    }
  }, ms).unref();
tick(expireTransactions, 2000);
tick(processDueWebhooks, 2000);
tick(() => {
  q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  q('DELETE FROM pairing_codes WHERE expires_at < ?').run(Date.now());
  q('DELETE FROM notify_codes WHERE expires_at < ?').run(Date.now());
}, 3600_000);

// Graceful stop (docker stop / redeploy sends SIGTERM): finish open requests, close SQLite.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    stopTelegram();
    try {
      await app.close();
      db.close();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  });
}

await app.listen({ port: config.port, host: process.env.HOST || '0.0.0.0' });
startTelegram();
console.log(`Paychi listening on port ${config.port}, public address ${config.baseUrl}`);
