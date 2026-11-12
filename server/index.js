import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { q } from './db.js';
import { ApiError } from './util.js';
import dashboardRoutes from './routes/dashboard.js';
import apiRoutes from './routes/api.js';
import deviceRoutes from './routes/device.js';
import payRoutes from './routes/pay.js';
import { expireTransactions } from './services/transactions.js';
import { processDueWebhooks } from './services/webhooks.js';

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
app.get('/healthz', async () => ({ ok: true }));

await app.register(dashboardRoutes, { prefix: '/api/dash' });
await app.register(apiRoutes, { prefix: '/api/v1' });
await app.register(deviceRoutes, { prefix: '/api/device' });
await app.register(payRoutes, { prefix: '/api/pay' });

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
}, 3600_000);

await app.listen({ port: config.port, host: process.env.HOST || '0.0.0.0' });
console.log(`Paychi listening on ${config.baseUrl}`);
