// End-to-end test: spawns the server on a temp DB and walks the whole flow.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseBankMessage } from '../server/parser.js';
import { Variz, VarizDevice, VarizError, verifyWebhook, signWebhook } from '../sdk/src/index.js';
import { detectBank } from '../server/bankDetect.js';

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

// ---- fake Telegram Bot API ----
const TG_PORT = 3989;
const tgSent = [];
const tgQueue = [];
let tgUpdateId = 0;
const tgServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const method = req.url.split('/').pop();
    const json = body ? JSON.parse(body) : {};
    const reply = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    if (!req.url.startsWith('/botTEST-TOKEN/')) return res.writeHead(401).end('{"ok":false,"description":"Unauthorized"}');
    if (method === 'getMe') return reply({ id: 1, is_bot: true, username: 'paychi_test_bot' });
    if (method === 'sendMessage') { tgSent.push(json); return reply({ message_id: tgSent.length }); }
    if (method === 'getUpdates') {
      const until = Date.now() + 300;
      while (!tgQueue.length && Date.now() < until) await sleep(50);
      return reply(tgQueue.splice(0).filter((u) => u.update_id >= (json.offset || 0)));
    }
    res.writeHead(404).end('{"ok":false}');
  });
}).listen(TG_PORT);

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_PATH: join(dir, 'test.db'),
    BILLING_MODE: 'mock', TX_MIN_TTL_SEC: '1', GRACE_SEC: '0', ALLOW_PRIVATE_WEBHOOKS: '1',
    TELEGRAM_BOT_TOKEN: 'TEST-TOKEN', TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
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
  await call('POST', '/api/dash/sources', { type: 'sms', value: '98200030' });
  d = (await dev0({ type: 'sms', sender: 'AnyBank', body: 'واریز 123,459' })).json;
  assert.deepEqual([d.accepted, d.reason], [false, 'source_not_allowed']);
  ok('sources: both on by default, mobile senders rejected, optional strict list');
  // a new account starts with one merchant; key + webhook are per merchant
  const shop = (await call('GET', '/api/dash/me')).json.merchants[0];
  assert.equal(shop.name, 'فروشگاه اصلی');
  const apiKey = (await call('POST', `/api/dash/merchants/${shop.id}/api-key`, {})).json.api_key;
  const secret = (await call('PATCH', `/api/dash/merchants/${shop.id}`, { webhook_url: `http://127.0.0.1:${HOOK_PORT}/hook` }))
    .json.merchant.webhook_secret;
  const api = (m, p, b) => call(m, '/api/v1' + p, b, { authorization: 'Bearer ' + apiKey, cookie: '' });
  const dev = (m, p, b) => call(m, '/api/device' + p, b, { authorization: 'Bearer ' + devToken, cookie: '' });
  assert.equal((await call('POST', '/api/v1/transactions', { amount: 500000 }, { authorization: 'Bearer nope' })).status, 401);
  const cfg = (await dev('GET', '/config')).json;
  assert.deepEqual(cfg.sms_senders, ['98200030']);
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
  r = await dev('POST', '/ingest', { type: 'sms', sender: '98200030', body: `برداشت ${t2.amount}\nمانده 1` });
  assert.equal(r.json.matched, false);
  r = await dev('POST', '/ingest', { type: 'sms', sender: '98200030', body: sms(t2.amount), received_at: 1 });
  assert.equal(r.json.matched, true);
  assert.equal(r.json.transaction_id, t2.id);
  r = await dev('POST', '/ingest', { type: 'sms', sender: '98200030', body: sms(t2.amount), received_at: 1 });
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

  // ---- JavaScript SDK against the real server
  const variz = new Variz({ apiKey, baseUrl: BASE });
  const s1 = await variz.transactions.create({ amount: 2_222_000, order_id: 'SDK-1', metadata: { a: 1 } });
  assert.equal(s1.status, 'pending');
  assert.equal((await variz.transactions.get(s1.id)).order_id, 'SDK-1');
  assert.equal((await variz.transactions.list({ order_id: 'SDK-1' }))[0].id, s1.id);
  assert.ok((await variz.cards.list()).length >= 2);
  await assert.rejects(new Variz({ apiKey: 'nope', baseUrl: BASE }).transactions.get(s1.id),
    (e) => e instanceof VarizError && e.status === 401 && e.code === 'invalid_api_key');
  await assert.rejects(variz.transactions.get('tx_missing'), (e) => e.code === 'not_found');
  // waitForPayment resolves once a custom listener (VarizDevice) reports the deposit
  const sdkPair = (await call('POST', '/api/dash/pairing', {})).json;
  const { device: sdkDev } = await VarizDevice.pair({ code: sdkPair.url.replace(/^https?:\/\/[^/]+/, BASE), deviceName: 'sdk' });
  const waiting = variz.transactions.waitForPayment(s1.id, { interval: 200 });
  const ing = await sdkDev.ingest({ sender: '98200030', body: `واریز ${s1.amount.toLocaleString('en-US')}\nمانده 1`, received_at: 42 });
  assert.equal(ing.transaction_id, s1.id);
  assert.equal((await waiting).status, 'paid');
  // webhook verification
  const sdkHook = await waitFor(() => hooks.find((h) => h.headers['x-paychi-event'] === 'transaction.paid' && JSON.parse(h.body).data.id === s1.id));
  const ev = await verifyWebhook(sdkHook.body, sdkHook.headers['x-paychi-signature'], secret);
  assert.equal(ev.data.order_id, 'SDK-1');
  await assert.rejects(verifyWebhook(sdkHook.body + ' ', sdkHook.headers['x-paychi-signature'], secret), (e) => e.code === 'invalid_signature');
  await assert.rejects(verifyWebhook(sdkHook.body, await signWebhook(sdkHook.body, secret, 1000), secret), (e) => e.code === 'invalid_signature');
  assert.equal((await verifyWebhook(Buffer.from('{"x":1}'), await signWebhook('{"x":1}', 's'), 's')).x, 1);
  await sdkDev.logout();
  ok('SDK: create/get/list/cards, errors, VarizDevice pair+ingest, waitForPayment, verifyWebhook');


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
  r = await dev('POST', '/ingest', { type: 'sms', sender: '98200030', body: sms(t4.amount) });
  assert.equal(r.json.matched, false);
  const t5 = (await api('POST', '/transactions', { amount: 700_000 })).json;
  assert.notEqual(t5.amount, t4.amount); // cooldown: a just-expired amount is not reused
  ok('expiry: status, webhook, late SMS not matched, amount cooldown');

  // ---- bank / card identification (SMS and notifications)
  for (const [s, b, want] of [
    ['Bank Mellat', 'واریز 1,000', 'mellat'],
    ['3000', '*بانك سامان*\nواريز ۲۵۰٬۰۰۳', 'saman'],
    ['x', 'بانک توسعه صادرات\nواریز 100,000', 'tosee_saderat'],
    ['x', 'بانک ملت\nواریز پایا از بانک ملی 1,000,000', 'mellat'],
    ['x', 'واریز پایا از بانک ملی به حساب شما 1,000,000', null],
    ['x', 'خرید از فروشگاه شهر کتاب', null],
    ['com.x', 'همراه بانک پاسارگاد\nواریز 1,000,000', 'pasargad'],
  ]) assert.equal(detectBank(s, b), want, b);
  // free SMS from any sender again (the strict list above only allows 98200030)
  for (const s of (await call('GET', '/api/dash/sources')).json.sources) await call('DELETE', '/api/dash/sources/' + s.id, {});
  const mk = async (amount, card) => (await api('POST', '/transactions', { amount, card_id: card.id })).json;
  const send = async (b) => (await dev('POST', '/ingest', b)).json;
  // money reported on Saman, transaction was for the Mellat card → not auto-confirmed
  const bm = await mk(300_000, cardA);
  d = await send({ type: 'sms', sender: '30001', body: `بانک سامان\nواریز ${bm.amount.toLocaleString('en-US')}` });
  assert.deepEqual([d.matched, d.reason, d.bank, d.transaction_id], [false, 'bank_mismatch', 'saman', bm.id]);
  const evs = (await call('GET', '/api/dash/events')).json.events;
  const mismatch = evs.find((e) => e.result === 'bank_mismatch');
  assert.equal(mismatch.bank_name, 'بانک سامان');
  const confirmed = (await call('POST', `/api/dash/events/${mismatch.id}/confirm`, {})).json;
  assert.equal(confirmed.status, 'paid'); // confirmed by hand
  // right bank → matched, and the sender's bank is remembered for messages without a bank name
  const bm2 = await mk(310_000, cardA);
  d = await send({ type: 'sms', sender: '30002', body: `بانک ملت\nواریز ${bm2.amount.toLocaleString('en-US')}` });
  assert.deepEqual([d.matched, d.bank], [true, 'mellat']);
  const bm3 = await mk(320_000, cardA);
  d = await send({ type: 'sms', sender: '30002', body: `واریز ${bm3.amount.toLocaleString('en-US')}` });
  assert.deepEqual([d.matched, d.bank], [true, 'mellat']);
  const learned = (await call('GET', '/api/dash/sender-banks')).json.sender_banks;
  assert.ok(learned.some((x) => x.sender === '30002' && x.bank_code === 'mellat' && x.auto));
  // the text names another of your cards → card_mismatch
  const bs = await mk(100_000, cardB);
  d = await send({ type: 'sms', sender: '30009', body: `واریز ${bs.amount.toLocaleString('en-US')} به کارت ****${cardA.number.slice(-4)}` });
  assert.deepEqual([d.matched, d.reason, d.card_id], [false, 'card_mismatch', cardA.id]);
  // bank app notification: bank from the title, remembered for the package
  const bs2 = await mk(150_000, cardB);
  d = await send({ type: 'notification', sender: 'com.example.saman', body: `همراه بانک سامان\nواریز ${bs2.amount.toLocaleString('en-US')} ریال` });
  assert.deepEqual([d.matched, d.bank], [true, 'saman']);
  assert.ok((await call('GET', '/api/dash/sender-banks')).json.sender_banks.some((x) => x.type === 'notification' && x.bank_code === 'saman'));
  // account number on a card identifies it
  await call('PATCH', '/api/dash/cards/' + cardB.id, { account_number: '0101234567' });
  const bs3 = await mk(120_000, cardB);
  d = await send({ type: 'sms', sender: '30010', body: `واریز ${bs3.amount.toLocaleString('en-US')} به حساب 0101234567` });
  assert.deepEqual([d.matched, d.card_id], [true, cardB.id]);
  // manual mapping overrides the learned one
  await call('POST', '/api/dash/sender-banks', { type: 'sms', sender: '30002', bank_code: 'saman' });
  const over = (await call('GET', '/api/dash/sender-banks')).json.sender_banks.find((x) => x.sender === '30002');
  assert.deepEqual([over.bank_code, over.auto], ['saman', false]);
  ok('bank/card identification: SMS + notifications, mismatch held back, manual confirm, learned + manual sender banks, account number');
  // merchants: many per account, own key / webhook / cards, isolated API, shared unique amounts
  const bot = (await call('POST', '/api/dash/merchants', { name: 'Bot', webhook_url: `http://127.0.0.1:${HOOK_PORT}/bot` })).json.merchant;
  assert.equal((await call('POST', '/api/dash/merchants', { name: '  ' })).status, 400);
  const botKey = (await call('POST', `/api/dash/merchants/${bot.id}/api-key`, {})).json.api_key;
  r = await call('PATCH', `/api/dash/merchants/${bot.id}`, { all_cards: false, card_ids: [cardA.id] });
  assert.deepEqual([r.json.merchant.all_cards, r.json.merchant.card_ids], [false, [cardA.id]]);
  assert.equal((await call('PATCH', `/api/dash/merchants/${bot.id}`, { card_ids: [999999] })).status, 400);
  const botApi = (m, p, b) => call(m, '/api/v1' + p, b, { authorization: 'Bearer ' + botKey, cookie: '' });
  assert.equal((await botApi('GET', '/merchant')).json.name, 'Bot');
  assert.deepEqual((await botApi('GET', '/cards')).json.data.map((c) => c.id), [cardA.id]);
  const mt1 = (await botApi('POST', '/transactions', { amount: 222_000, order_id: 'BOT-1' })).json;
  assert.deepEqual([mt1.card.id, mt1.merchant.name, mt1.amount], [cardA.id, 'Bot', 222_000]);
  assert.equal((await botApi('POST', '/transactions', { amount: 222_000, card_id: cardB.id })).json.error.code, 'card_not_found');
  // same amount from the other merchant gets the next unique amount (one phone sees both)
  const mt2 = (await api('POST', '/transactions', { amount: 222_000, order_id: 'SHOP-1' })).json;
  assert.equal(mt2.amount, 222_001);
  assert.equal(mt2.merchant.id, shop.id);
  // each key sees only its own merchant's transactions
  assert.equal((await api('GET', '/transactions/' + mt1.id)).status, 404);
  assert.equal((await api('POST', `/transactions/${mt1.id}/cancel`, {})).status, 404);
  assert.deepEqual((await botApi('GET', '/transactions')).json.data.map((t) => t.id), [mt1.id]);
  assert.deepEqual((await call('GET', `/api/dash/transactions?merchant_id=${bot.id}`)).json.transactions.map((t) => t.id), [mt1.id]);
  // payment → webhook to the merchant's own URL, signed with its own secret
  hooks.length = 0;
  d = (await dev('POST', '/ingest', { type: 'sms', sender: '98200030', body: sms(mt1.amount) })).json;
  assert.deepEqual([d.matched, d.transaction_id], [true, mt1.id]);
  const botHook = await waitFor(() => hooks.find((h) => h.body.includes(mt1.id)));
  assert.equal(JSON.parse(botHook.body).data.merchant.id, bot.id);
  const botEvent = await verifyWebhook(botHook.body, botHook.headers['x-paychi-signature'], bot.webhook_secret);
  assert.equal(botEvent.event, 'transaction.paid');
  await assert.rejects(verifyWebhook(botHook.body, botHook.headers['x-paychi-signature'], secret));
  assert.equal((await call('GET', '/api/pay/' + mt1.id)).json.merchant_name, 'Bot');
  await api('POST', `/transactions/${mt2.id}/cancel`, {});
  // a merchant with transactions is archived (key revoked); an empty one is deleted
  assert.deepEqual((await call('DELETE', `/api/dash/merchants/${bot.id}`, {})).json, { archived: true });
  assert.equal((await botApi('GET', '/merchant')).status, 401);
  const tmp = (await call('POST', '/api/dash/merchants', { name: 'Temp' })).json.merchant;
  assert.deepEqual((await call('DELETE', `/api/dash/merchants/${tmp.id}`, {})).json, { archived: false });
  const list = (await call('GET', '/api/dash/merchants')).json.merchants;
  assert.deepEqual(list.map((m) => [m.name, m.active]), [['فروشگاه اصلی', true], ['Bot', false]]);
  ok('merchants: own key/webhook/cards, API isolation, shared unique amounts, archive/delete');
  // payment links: fixed amount + payer info, open amount with range, deactivate
  const pubLink = (slug) => call('GET', '/api/pay/link/' + slug, undefined, { cookie: '' });
  const startLink = (slug, b) => call('POST', '/api/pay/link/' + slug, b, { cookie: '' });
  const lk = (await call('POST', `/api/dash/merchants/${shop.id}/links`, { title: 'اشتراک ماهانه', amount: 333_000, ask_payer: true })).json.link;
  assert.match(lk.url, /\/l\/[a-z0-9]{8}$/);
  assert.ok(lk.qr_svg.startsWith('<svg'));
  assert.equal((await fetch(lk.url)).status, 200);
  assert.deepEqual(
    (({ title, amount, ask_payer, active, merchant_name }) => ({ title, amount, ask_payer, active, merchant_name }))((await pubLink(lk.slug)).json),
    { title: 'اشتراک ماهانه', amount: 333_000, ask_payer: true, active: true, merchant_name: 'فروشگاه اصلی' });
  assert.equal((await startLink(lk.slug, {})).json.error.code, 'payer_required');
  const ls = (await startLink(lk.slug, { payer_name: 'مریم', payer_phone: '۰۹۱۲ ۰۰۰ ۱۱۱۱' })).json;
  assert.match(ls.payment_url, /^\/pay\/tx_/);
  const ltx = (await api('GET', '/transactions/' + ls.id)).json;
  assert.deepEqual([ltx.amount, ltx.description, ltx.metadata.payer_name, ltx.metadata.payer_phone], [333_000, 'اشتراک ماهانه', 'مریم', '09120001111']);
  const open = (await call('POST', `/api/dash/merchants/${shop.id}/links`, { title: 'حمایت', min_amount: 50_000, max_amount: 100_000 })).json.link;
  assert.equal((await startLink(open.slug, { amount: 10 })).json.error.code, 'invalid_amount');
  const os = (await startLink(open.slug, { amount: '۸۰,۰۰۰' })).json;
  assert.equal((await api('GET', '/transactions/' + os.id)).json.amount, 80_000);
  await call('PATCH', `/api/dash/links/${open.id}`, { active: false });
  assert.equal((await pubLink(open.slug)).json.active, false);
  assert.equal((await startLink(open.slug, { amount: 80_000 })).status, 410);
  assert.equal((await call('GET', '/api/pay/link/nope1234', undefined, { cookie: '' })).status, 404);
  await api('POST', `/transactions/${os.id}/cancel`, {});
  ok('payment links: fixed / open amount, payer info, range check, deactivate');

  // Telegram alerts: one-tap connect via /start <code>, then a message per payment
  const tgInfo = await waitFor(async () => {
    const j = (await call('GET', `/api/dash/merchants/${shop.id}/telegram`)).json;
    return j.bot ? j : null;
  });
  assert.deepEqual([tgInfo.enabled, tgInfo.bot, tgInfo.channels.length], [true, 'paychi_test_bot', 0]);
  const tc = (await call('POST', `/api/dash/merchants/${shop.id}/telegram/connect`, {})).json;
  assert.equal(tc.link, `https://t.me/paychi_test_bot?start=${tc.code}`);
  const tgMsg = (text) => tgQueue.push({ update_id: ++tgUpdateId, message: { chat: { id: 555, type: 'private', first_name: 'Ali' }, text } });
  tgMsg('/start not-a-valid-code');
  await waitFor(() => tgSent.find((m) => m.text.includes('معتبر نیست')));
  tgMsg('/start ' + tc.code);
  await waitFor(() => tgSent.find((m) => m.text.includes('وصل شد')));
  const chans = (await call('GET', `/api/dash/merchants/${shop.id}/telegram`)).json.channels;
  assert.deepEqual(chans.map((c) => [c.chat_id, c.title]), [['555', 'Ali']]);
  tgMsg('/start ' + tc.code); // single use
  await waitFor(() => tgSent.filter((m) => m.text.includes('معتبر نیست')).length === 2);
  d = (await dev('POST', '/ingest', { type: 'sms', sender: '98200030', body: sms(ltx.amount) })).json;
  assert.deepEqual([d.matched, d.transaction_id], [true, ltx.id]);
  const paidMsg = await waitFor(() => tgSent.find((m) => m.text.startsWith('✅ پرداخت دریافت شد')));
  assert.equal(paidMsg.chat_id, '555');
  assert.ok(paidMsg.text.includes('مریم') && paidMsg.text.includes('اشتراک ماهانه') && paidMsg.text.includes(ltx.id));
  assert.equal((await call('POST', `/api/dash/telegram/${chans[0].id}/test`, {})).status, 200);
  assert.equal((await call('GET', `/api/dash/merchants/${shop.id}/links`)).json.links.find((l) => l.id === lk.id).paid, 1);
  ok('Telegram: one-tap connect, invalid / reused code rejected, payment alert with payer details');
  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  process.exitCode = 1;
} finally {
  server.kill();
  hookServer.close();
  tgServer.close();
  await sleep(300);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
