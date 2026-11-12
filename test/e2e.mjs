// End-to-end test: spawns the server on a temp DB and walks the whole flow.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseBankMessage } from '../server/parser.js';

const PORT = 3987;
const HOOK_PORT = 3988;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'paychi-'));
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

// ---- parser unit checks ----
const cases = [
  ['بانک ملت\nحساب 1234567\nواریز 1,500,037\nمانده 9,000,000\n1403/08/20 12:30', true, 1500037],
  ['انتقال:1,000,012+\nحساب:0101234\nمانده:25,000,000\n0820-12:30', true, 1000012],
  ['واریز به: 0102030405006\nمبلغ: 2,000,005 ریال\nموجودی: 3,000,000', true, 2000005],
  ['*بانک سامان*\nواریز مبلغ ۲۵۰٬۰۰۳ ریال به حساب ۸۴۹...', true, 250003],
  ['واریز 150,000 تومان', true, 1500000],
  ['برداشت 1,500,037\nمانده 9,000,000', false, 1500037],
  ['خرید\nمبلغ: 450,000\nمانده: 1,000,000', false, 450000],
  ['کد تایید شما 123456', false, null],
  ['مانده: 5,000,000+', false, null],
];
for (const [text, dep, amt] of cases) {
  const r = parseBankMessage(text);
  assert.equal(r.isDeposit, dep, 'isDeposit for: ' + text);
  if (dep) assert.equal(r.amount, amt, 'amount for: ' + text);
}
ok(`parser: ${cases.length} message formats`);

// ---- webhook receiver ----
const hooks = [];
const hookServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hooks.push({ headers: req.headers, body });
    res.writeHead(200).end('ok');
  });
}).listen(HOOK_PORT);

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_PATH: join(dir, 'test.db'),
    BILLING_MODE: 'mock', TX_MIN_TTL_SEC: '1', GRACE_SEC: '0', ALLOW_PRIVATE_WEBHOOKS: '1',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}
const luhn = (p15) => {
  for (let d = 0; d < 10; d++) {
    const n = p15 + d;
    let s = 0;
    for (let i = 0; i < 16; i++) { let x = +n[i]; if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } s += x; }
    if (s % 10 === 0) return n;
  }
};
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await sleep(100);
  }
}

try {
  await waitFor(() => fetch(BASE + '/healthz').then((r) => r.ok, () => false), 10_000);

  // register + auth guard
  assert.equal((await call('GET', '/api/dash/me')).status, 401);
  assert.equal((await call('POST', '/api/dash/register', { phone: '09121234567', password: 'secret-pass-1', name: 'Test' })).status, 200);
  let me = (await call('GET', '/api/dash/me')).json;
  assert.equal(me.user.phone, '09121234567');
  assert.equal(me.subscription, null);
  ok('register + session');

  // subscription is required before cards / transactions
  const mellat = luhn('610433700000001');
  const saman = luhn('621986100000002');
  assert.equal((await call('POST', '/api/dash/cards', { number: mellat })).status, 402);
  me = (await call('POST', '/api/dash/subscribe', { plan_id: 'starter' })).json;
  assert.equal(me.subscription.plan.id, 'starter');
  ok('subscription gate + mock activation');

  // cards + bank identification + limits
  assert.equal((await call('POST', '/api/dash/cards', { number: '6104337000000000' })).status, 400);
  let r = await call('POST', '/api/dash/cards', { number: mellat, holder_name: 'علی رضایی' });
  assert.equal(r.json.cards[0].bank, 'mellat');
  assert.equal(r.json.cards[0].daily_limit, 100_000_000);
  r = await call('POST', '/api/dash/cards', { number: saman, daily_limit: 5_000_000 });
  assert.equal(r.json.cards[1].bank, 'saman');
  assert.equal(r.json.cards[1].daily_limit, 5_000_000);
  const [cardA, cardB] = r.json.cards;
  assert.equal((await call('POST', '/api/dash/cards', { number: luhn('603799100000003') })).status, 402); // plan max 2
  ok('cards: Luhn, BIN → bank, default/custom limit, plan cap');

  // device + source + api key + webhook
  const devToken = (await call('POST', '/api/dash/devices', { name: 'Pixel', platform: 'android' })).json.token;
  const dev0 = (b) => call('POST', '/api/device/ingest', b, { authorization: 'Bearer ' + devToken, cookie: '' });
  // default mode: no sources configured → both SMS and notifications are accepted
  let d = (await dev0({ type: 'sms', sender: 'AnyBank', body: 'واریز 123,456 مانده 1' })).json;
  assert.deepEqual([d.accepted, d.matched], [true, false]);
  d = (await dev0({ type: 'notification', sender: 'com.some.bank', body: 'واریز 123,457' })).json;
  assert.equal(d.accepted, true);
  d = (await dev0({ type: 'sms', sender: '0935 000 0000', body: 'واریز 123,458' })).json;
  assert.deepEqual([d.accepted, d.reason], [false, 'sender_is_mobile_number']);
  d = (await dev0({ type: 'sms', sender: 'AnyBank', body: 'کد تایید 55555' })).json;
  assert.deepEqual([d.accepted, d.reason], [false, 'not_a_deposit']);
  // adding a sender switches SMS to strict mode
  await call('POST', '/api/dash/sources', { type: 'sms', value: 'Bank Mellat' });
  d = (await dev0({ type: 'sms', sender: 'AnyBank', body: 'واریز 123,459' })).json;
  assert.deepEqual([d.accepted, d.reason], [false, 'source_not_allowed']);
  ok('sources: both on by default, mobile senders rejected, optional strict list');
  const apiKey = (await call('POST', '/api/dash/api-key/rotate', {})).json.api_key;
  me = (await call('PATCH', '/api/dash/settings', { webhook_url: `http://127.0.0.1:${HOOK_PORT}/hook` })).json;
  const secret = me.settings.webhook_secret;
  const api = (m, p, b) => call(m, '/api/v1' + p, b, { authorization: 'Bearer ' + apiKey, cookie: '' });
  const dev = (m, p, b) => call(m, '/api/device' + p, b, { authorization: 'Bearer ' + devToken, cookie: '' });
  assert.equal((await call('POST', '/api/v1/transactions', { amount: 500000 }, { authorization: 'Bearer nope' })).status, 401);
  const cfg = (await dev('GET', '/config')).json;
  assert.deepEqual(cfg.sms_senders, ['Bank Mellat']);
  ok('device pairing, sources, API key');

  // app sign-in pairs a device without a token
  const login = (b) => call('POST', '/api/device/login', b, { cookie: '' });
  assert.equal((await login({ phone: '09121234567', password: 'wrong-pass' })).status, 401);
  const l1 = (await login({ phone: '0912 123 4567', password: 'secret-pass-1', device_name: 'Galaxy', install_id: 'abc' })).json;
  assert.match(l1.token, /^dev_/);
  const asDev = (tok, m, p) => call(m, '/api/device' + p, m === 'POST' ? {} : undefined, { authorization: 'Bearer ' + tok, cookie: '' });
  assert.equal((await asDev(l1.token, 'GET', '/config')).json.account.phone, '09121234567');
  const l2 = (await login({ phone: '09121234567', password: 'secret-pass-1', device_name: 'Galaxy', install_id: 'abc' })).json;
  assert.equal(l2.device.id, l1.device.id); // same install → same device, new token
  assert.equal((await asDev(l1.token, 'GET', '/config')).status, 401);
  assert.equal((await call('GET', '/api/dash/devices')).json.devices.length, 2);
  assert.equal((await asDev(l2.token, 'POST', '/logout')).status, 200);
  assert.equal((await asDev(l2.token, 'GET', '/config')).status, 401);
  ok('app sign-in: pairs device, re-login reuses it, logout revokes');

  // quick connect: one-time pairing code behind a link + QR
  const pair = (code) => call('POST', '/api/device/pair', { code, device_name: 'QR phone', install_id: 'qr1' }, { cookie: '' });
  const p1 = (await call('POST', '/api/dash/pairing', { origin: 'http://192.168.1.5:3000' })).json;
  assert.match(p1.url, /^http:\/\/192\.168\.1\.5:3000\/connect#[\w-]{20,}$/);
  assert.ok(p1.qr_svg.startsWith('<svg'));
  assert.equal((await fetch(BASE + '/connect')).status, 200);
  const code1 = p1.url.split('#')[1];
  assert.equal((await pair('not-a-real-code-000000')).status, 401);
  const paired = await pair(code1);
  assert.equal(paired.status, 200);
  assert.equal((await asDev(paired.json.token, 'GET', '/config')).status, 200);
  assert.equal((await pair(code1)).status, 401); // single use
  const p2 = (await call('POST', '/api/dash/pairing', {})).json;
  const p3 = (await call('POST', '/api/dash/pairing', {})).json;
  assert.equal((await pair(p2.url.split('#')[1])).status, 401); // superseded by the newer code
  assert.equal((await pair(p3.url.split('#')[1])).status, 200);
  await asDev(paired.json.token, 'POST', '/logout');
  ok('quick connect: link + QR, single use, newest code only');

  // unique amounts
  const t1 = (await api('POST', '/transactions', { amount: 1_500_000, order_id: 'A-1', metadata: { u: 7 } })).json;
  const t2 = (await api('POST', '/transactions', { amount: 1_500_000, order_id: 'A-2' })).json;
  const t3 = (await api('POST', '/transactions', { amount: 1_500_000, order_id: 'A-3' })).json;
  assert.equal(t1.status, 'pending');
  assert.equal(new Set([t1.amount, t2.amount, t3.amount]).size, 3);
  assert.deepEqual([t1.amount, t2.amount, t3.amount], [1_500_000, 1_500_001, 1_500_002]);
  assert.ok(t1.payment_url.endsWith('/pay/' + t1.id));
  assert.match(t1.card.number, /^\d{16}$/);
  ok('transactions: unique id + unique amount + card + expiry');

  // public pay page data
  const pub = (await call('GET', '/api/pay/' + t2.id)).json;
  assert.equal(pub.amount, t2.amount);
  assert.ok(pub.card.colors.length === 2);
  assert.equal((await fetch(BASE + '/pay/' + t2.id)).status, 200);
  ok('public payment page');

  // ingest: wrong source ignored, withdrawal ignored, deposit matches exactly one tx
  const sms = (amount) => `حساب 1234567\nواریز ${amount.toLocaleString('en-US')}\nمانده 99,000,000`;
  r = await dev('POST', '/ingest', { type: 'sms', sender: '+989350000000', body: sms(t2.amount) });
  assert.equal(r.json.accepted, false);
  r = await dev('POST', '/ingest', { type: 'sms', sender: 'Bank Mellat', body: `برداشت ${t2.amount}\nمانده 1` });
  assert.equal(r.json.matched, false);
  r = await dev('POST', '/ingest', { type: 'sms', sender: 'bank mellat', body: sms(t2.amount), received_at: 1 });
  assert.equal(r.json.matched, true);
  assert.equal(r.json.transaction_id, t2.id);
  r = await dev('POST', '/ingest', { type: 'sms', sender: 'bank mellat', body: sms(t2.amount), received_at: 1 });
  assert.equal(r.json.duplicate, true);
  assert.equal((await api('GET', '/transactions/' + t2.id)).json.status, 'paid');
  assert.equal((await api('GET', '/transactions/' + t1.id)).json.status, 'pending');
  ok('ingest: source whitelist, withdrawal ignored, exact match, dedupe');

  // webhook with valid signature
  const hook = await waitFor(() => hooks.find((h) => h.headers['x-paychi-event'] === 'transaction.paid'));
  const [, ts, sig] = /t=(\d+),v1=([0-9a-f]+)/.exec(hook.headers['x-paychi-signature']);
  assert.equal(sig, createHmac('sha256', secret).update(`${ts}.${hook.body}`).digest('hex'));
  const payload = JSON.parse(hook.body);
  assert.equal(payload.data.id, t2.id);
  assert.equal(payload.data.order_id, 'A-2');
  ok('webhook: transaction.paid delivered with valid HMAC signature');

  // cancel
  assert.equal((await api('POST', `/transactions/${t3.id}/cancel`, {})).json.status, 'cancelled');
  assert.equal((await api('POST', `/transactions/${t3.id}/cancel`, {})).status, 409);
  ok('cancel');

  // daily ceiling: card B has a 5M limit, card A 100M
  r = await api('POST', '/transactions', { amount: 6_000_000, card_id: cardB.id });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'card_limit_reached');
  assert.equal(t2.card.id, cardB.id); // least-used card was picked, so B already received ~1.5M
  r = await api('POST', '/transactions', { amount: 3_000_000, card_id: cardB.id });
  assert.equal(r.status, 201);
  r = await api('POST', '/transactions', { amount: 1_000_000, card_id: cardB.id });
  assert.equal(r.json.error.code, 'card_limit_reached'); // 1.5M paid + 3M reserved + 1M > 5M
  await call('PATCH', '/api/dash/cards/' + cardA.id, { daily_limit: 2_000_000 });
  r = await api('POST', '/transactions', { amount: 3_000_000 });
  assert.equal(r.json.error.code, 'card_limit_reached'); // no card can take it now
  await call('PATCH', '/api/dash/cards/' + cardA.id, { daily_limit: null });
  await call('PATCH', '/api/dash/settings', { default_card_limit: 50_000_000 });
  const cards = (await api('GET', '/cards')).json.data;
  assert.equal(cards[0].daily_limit, 50_000_000);
  assert.equal(cards[1].received_today, t2.amount);
  assert.equal(cards[1].remaining_today, 5_000_000 - t2.amount - 3_000_000);
  ok('card-to-card ceiling: per card, per user default, reservation by open transactions');

  // expiry + webhook
  const t4 = (await api('POST', '/transactions', { amount: 700_000, ttl: 1 })).json;
  await waitFor(async () => (await api('GET', '/transactions/' + t4.id)).json.status === 'expired', 8000);
  await waitFor(() => hooks.find((h) => h.headers['x-paychi-event'] === 'transaction.expired' && JSON.parse(h.body).data.id === t4.id));
  r = await dev('POST', '/ingest', { type: 'sms', sender: 'Bank Mellat', body: sms(t4.amount) });
  assert.equal(r.json.matched, false);
  const t5 = (await api('POST', '/transactions', { amount: 700_000 })).json;
  assert.notEqual(t5.amount, t4.amount); // cooldown: a just-expired amount is not reused
  ok('expiry: status, webhook, late SMS not matched, amount cooldown');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  process.exitCode = 1;
} finally {
  server.kill();
  hookServer.close();
  await sleep(300);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
