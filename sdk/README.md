# @paychi/variz

JavaScript client for **Paychi Variz** — card-to-card (کارت به کارت) payments confirmed
automatically by the bank SMS / notification on your own phone.

- Zero dependencies. Node.js 18+, Bun, Deno, Cloudflare Workers — anything with `fetch`.
- TypeScript types included.
- Private package (`"private": true`): install it from this repo, it is not on npm.

> **Keep the API key on your server.** It can create and cancel transactions for your account.
> Never put it in browser code or a mobile app.

---

## Contents

1. [Install](#install)
2. [Quick start](#quick-start)
3. [How a payment works](#how-a-payment-works)
4. [Transactions](#transactions)
5. [Webhooks](#webhooks)
6. [No webhook? Wait for payment](#no-webhook-wait-for-payment)
7. [Cards and daily limits](#cards-and-daily-limits)
8. [Errors](#errors)
9. [Custom listener (VarizDevice)](#custom-listener-varizdevice)
10. [Recipes: Telegram bot, Express shop](#recipes)
11. [Raw HTTP API](#raw-http-api)

---

## Install

From another project on the same machine:

```bash
npm install ../paychi-variz/sdk
```

From a private GitHub repo (once the repo is pushed; `npm` needs access to it):

```bash
npm install "github:<owner>/<repo>#main" --install-links
```

> npm can't install a sub-folder of a git repo directly. If you install from GitHub, either
> push `sdk/` as its own repo, or copy `sdk/src/` into your project — it is two files.

## Quick start

```js
import { Variz } from '@paychi/variz';

const variz = new Variz({
  apiKey: process.env.VARIZ_API_KEY,   // dashboard → فروشگاه‌ها → (merchant) → "ساخت کلید API"
  baseUrl: process.env.VARIZ_URL,      // e.g. https://pay.example.com
});

const tx = await variz.transactions.create({
  amount: 1_500_000,          // Rial
  order_id: 'INV-1001',
  description: 'Pro plan',
});

console.log(tx.payment_url);  // send the payer here, or show the details yourself:
console.log(`Transfer exactly ${tx.amount} Rial to ${tx.card.number} (${tx.card.bank_name}) before ${tx.expires_at}`);
```

## Merchants

One account can run many **merchants** (فروشگاه): a site, a Telegram bot, another app. Each
merchant has its **own API key, webhook URL + secret, payment window and transactions**, and
uses all of the account's cards or a chosen subset. Create them in dashboard → فروشگاه‌ها.

The API key decides the merchant: everything you do with a key (create, list, get, cancel, cards)
only sees that merchant's data. The listener phone and the cards are shared, so unique amounts
are unique across all merchants of the account.

```js
const shop = new Variz({ apiKey: process.env.SHOP_KEY, baseUrl });
const bot  = new Variz({ apiKey: process.env.BOT_KEY,  baseUrl });
await bot.merchant.get();   // { id: 2, name: 'ربات تلگرام', website: null }
```

**No-code option:** merchants without a backend can use payment links (`/l/<slug>`, created on the
merchant's page) and Telegram alerts instead of the API. Link payments are ordinary transactions
of the merchant: they show up in `transactions.list`, fire webhooks, and carry
`metadata.payment_link` (plus `payer_name` / `payer_phone` when the link asks for them).

## How a payment works

1. You create a transaction for an amount. Paychi returns a **unique id** and a **unique amount**
   (the requested amount plus a few Rial, so no two open transactions share an amount), the card
   to pay to, a hosted `payment_url` and an expiry time.
2. The payer transfers **exactly** that amount, card to card.
3. Your phone (Android listener app) receives the bank's deposit SMS / notification and forwards it.
4. Paychi matches the amount → the transaction becomes `paid` → your webhook is called.
5. If nobody pays in time it becomes `expired` (webhook `transaction.expired`).

All amounts are integer **Rial** (`IRR`). Divide by 10 for Toman.

Statuses: `pending` → `paid` | `expired` | `cancelled`.

## Transactions

### `transactions.create(params)`

| Param | Type | |
|---|---|---|
| `amount` | number | **Required.** Rial, minimum 10,000. |
| `order_id` | string | Your reference. Returned in webhooks; searchable. |
| `description` | string | Shown on the payment page. |
| `callback_url` | string | Webhook URL for this transaction only. |
| `return_url` | string | Payment page sends the payer here afterwards with `?tx_id=…&status=…`. |
| `card_id` | number | Force a card. Default: least-used card with room under its daily limit. |
| `ttl` | number | Seconds to pay (dashboard sets the default, usually 600). |
| `metadata` | object | Any JSON, returned with the transaction. |

Returns a `Transaction`:

```js
{
  id: 'tx_k3m9…',
  status: 'pending',
  amount: 1500003,            // ← the payer must transfer exactly this
  requested_amount: 1500000,
  currency: 'IRR',
  merchant: { id: 2, name: 'ربات تلگرام' },  // owner of the API key
  order_id: 'INV-1001',
  description: 'Pro plan',
  card: { id: 1, number: '6104…', bank: 'mellat', bank_name: 'بانک ملت', holder_name: '…' },
  payment_url: 'https://pay.example.com/pay/tx_k3m9…',
  return_url: null,
  metadata: null,
  created_at: '2026-11-13T10:00:00.000Z',
  expires_at: '2026-11-13T10:10:00.000Z',
  paid_at: null,
}
```

### Other methods

```js
await variz.transactions.get('tx_k3m9…');                       // one transaction
await variz.transactions.list({ order_id: 'INV-1001' });        // array, newest first
await variz.transactions.list({ status: 'paid', limit: 50 });
await variz.transactions.cancel('tx_k3m9…');                     // only while pending
```

## Webhooks

Set the URL per merchant in dashboard → فروشگاه‌ها → (merchant) → «آدرس وب‌هوک» (or per transaction
with `callback_url`). Each merchant has its own webhook secret.
Paychi `POST`s JSON:

```json
{ "event": "transaction.paid", "created_at": "…", "data": { /* Transaction */ } }
```

Events: `transaction.paid`, `transaction.expired`, `transaction.cancelled`.
Answer with any `2xx`. Otherwise it retries 5 more times (10 s, 1 min, 5 min, 30 min, 2 h).
The same event can arrive twice — make your handler idempotent (check `data.id` / `order_id`).

**Always verify the signature** with the webhook secret from the dashboard, using the **raw** body:

```js
import express from 'express';
import { verifyWebhook } from '@paychi/variz';

const app = express();

app.post('/webhooks/paychi', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook(req.body, req.get('x-paychi-signature'), process.env.VARIZ_WEBHOOK_SECRET);
  } catch {
    return res.sendStatus(400);
  }
  if (event.event === 'transaction.paid') {
    await markOrderPaid(event.data.order_id, event.data.id);   // your code
  }
  res.sendStatus(200);
});
```

Fetch-style runtimes (Next.js route handlers, Hono, Workers, Bun):

```js
export async function POST(request) {
  const event = await verifyWebhook(await request.text(), request.headers.get('x-paychi-signature'), SECRET);
  // …
  return new Response('ok');
}
```

`verifyWebhook` rejects signatures older than 5 minutes (`{ tolerance: 300 }` seconds).
For tests, `signWebhook(body, secret)` returns a valid header value.

## No webhook? Wait for payment

Bots and scripts without a public URL can poll:

```js
const tx = await variz.transactions.create({ amount: 500_000, order_id: 'chat-42' });
// … show tx.card.number and tx.amount to the user …
const done = await variz.transactions.waitForPayment(tx.id, { interval: 3000 });
if (done.status === 'paid') deliver();
else tell('Payment expired');   // 'expired' or 'cancelled'
```

Resolves when the transaction is no longer pending (at the latest when it expires).
Options: `interval` (ms), `timeout` (ms, throws), `signal` (AbortSignal).

## Cards and daily limits

```js
const cards = await variz.cards.list();
// [{ id, number, bank, bank_name, holder_name, active,
//    daily_limit, daily_limit_is_custom, received_today, reserved, remaining_today }]
```

Each card has a daily card-to-card ceiling (سقف) — a system default, overridable per account and
per card in the dashboard. Money received today plus pending transactions count against it.
When no card has room, `create` fails with `card_limit_reached`.

## Errors

Every failure throws `VarizError` with `status` (HTTP, `0` for network) and `code`:

```js
import { VarizError } from '@paychi/variz';

try {
  await variz.transactions.create({ amount: 900_000_000 });
} catch (e) {
  if (e instanceof VarizError && e.code === 'card_limit_reached') { /* add a card / raise the limit */ }
  else throw e;
}
```

| `code` | status | Meaning |
|---|---|---|
| `invalid_api_key` | 401 | Wrong or rotated key, or the merchant was deleted / archived |
| `merchant_inactive` | 403 | Merchant is archived |
| `subscription_required` | 402 | No active plan |
| `plan_limit_reached` | 402 | Plan's transaction quota used up |
| `invalid_amount` | 400 | Not an integer ≥ 10,000 |
| `no_active_card` / `card_not_found` | 422 | Add or activate a card, or allow it for this merchant |
| `card_limit_reached` | 422 | All eligible cards hit their daily limit |
| `no_unique_amount` | 409 | Too many open transactions with that amount; retry shortly |
| `not_found` | 404 | Unknown transaction id |
| `not_pending` | 409 | Cancel on a finished transaction |
| `rate_limited` | 429 | More than 600 requests / minute |
| `timeout` / `network_error` | 0 | Client side |

## Custom listener (VarizDevice)

Normally the Android app forwards bank messages. To build your own listener (another app, an SMS
gateway, a script reading a modem), use `VarizDevice`:

```js
import { VarizDevice } from '@paychi/variz';

// Pair with the dashboard's quick-connect QR link (one-time, 10 minutes)…
const { device } = await VarizDevice.pair({ code: 'https://pay.example.com/connect#AbC…', deviceName: 'SMS gateway' });
// …or with a token from dashboard → API → «توکن دستگاه»:
// const device = new VarizDevice({ baseUrl: 'https://pay.example.com', token: 'dev_…' });

const result = await device.ingest({
  type: 'sms',
  sender: 'Bank Mellat',
  body: 'واریز 1,500,003\nمانده 9,000,000',
  received_at: Date.now(),
});
// { accepted: true, matched: true, transaction_id: 'tx_…', amount: 1500003, bank: 'mellat', card_id: null }
```

Rules applied on the server: only deposits are matched; SMS from ordinary mobile numbers are
rejected; if the dashboard has a sender list, only those senders count.

**Bank and card identification** (SMS and notifications alike):

- The bank comes from the sender name or the text (`بانک ملت`, `*بانك سامان*`, `Mellat`…). A bank
  named after «از» / "from" is the payer's bank and is ignored. Once a sender (SMS sender id or app
  package) has been recognised, it is remembered, so later messages without a bank name still
  count; the mapping can be corrected in the dashboard.
- The card comes from a masked card / account number in the text (`****1234`, `6104-33**-****-0016`)
  or a full account number saved on the card in the dashboard.
- If the message points to a **different card or bank** than the transaction with that amount,
  it is **not** confirmed automatically (`reason: 'card_mismatch' | 'bank_mismatch'`). The dashboard
  shows it with a «تأیید دستی» (confirm by hand) button.
- Unknown bank / no card in the text → matched on the unique amount alone, as before.

## Recipes

### Telegram bot (polling, no webhook needed)

```js
import { Variz } from '@paychi/variz';
const variz = new Variz({ apiKey: process.env.VARIZ_API_KEY, baseUrl: process.env.VARIZ_URL });

bot.command('buy', async (ctx) => {
  const tx = await variz.transactions.create({ amount: 2_000_000, order_id: `tg-${ctx.from.id}-${Date.now()}` });
  await ctx.reply(
    `مبلغ دقیق ${tx.amount.toLocaleString('fa-IR')} ریال را به کارت\n${tx.card.number}\n(${tx.card.bank_name}) واریز کنید.\n` +
    `مهلت: ۱۰ دقیقه\nیا: ${tx.payment_url}`,
  );
  const done = await variz.transactions.waitForPayment(tx.id);
  await ctx.reply(done.status === 'paid' ? 'پرداخت تأیید شد ✅' : 'مهلت پرداخت تمام شد.');
});
```

### Shop checkout (redirect + webhook)

```js
const tx = await variz.transactions.create({
  amount: order.totalRial,
  order_id: order.id,
  return_url: `https://shop.example/orders/${order.id}`,
});
res.redirect(tx.payment_url);
// fulfil the order in the webhook handler (see Webhooks), not on return_url
```

## Raw HTTP API

The SDK wraps these endpoints; use them directly from any language.

| | Endpoint | Auth |
|---|---|---|
| Create | `POST /api/v1/transactions` | `Authorization: Bearer pk_live_…` |
| Get | `GET /api/v1/transactions/:id` | API key |
| List | `GET /api/v1/transactions?order_id=&status=&limit=` | API key |
| Cancel | `POST /api/v1/transactions/:id/cancel` | API key |
| Cards | `GET /api/v1/cards` | API key |
| Merchant | `GET /api/v1/merchant` | API key |
| Pair device | `POST /api/device/pair` `{ code }` | none |
| Device login | `POST /api/device/login` `{ phone, password }` | none |
| Device config | `GET /api/device/config` | `Bearer dev_…` |
| Ingest | `POST /api/device/ingest` `{ type, sender, body }` | `Bearer dev_…` |

Errors: `{ "error": { "code": "…", "message": "…" } }`.
Webhook header: `X-Paychi-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`.
