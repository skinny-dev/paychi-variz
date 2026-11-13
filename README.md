# Paychi Variz

Card-to-card (کارت به کارت) payment automation. A merchant registers their own bank cards,
pairs their own phone as a listener, and creates transactions through an API. Each transaction
gets a **unique id** and a **unique amount**; when the bank's deposit SMS / app notification
for exactly that amount reaches the merchant's phone, the transaction is marked paid and a
signed webhook is sent.

```
merchant backend ──POST /api/v1/transactions──▶ Paychi ──▶ { id, unique amount, card, payment_url, expires_at }
payer ── opens payment_url, transfers the exact amount card-to-card
bank ── deposit SMS / notification ──▶ merchant's phone (listener app) ──POST /api/device/ingest──▶ Paychi
Paychi ── matches amount → paid ── signed webhook ──▶ merchant backend
```

## Run

Requires Node.js 22.13+ (uses the built-in `node:sqlite`; no native modules).

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000, register, then follow the checklist on the dashboard.
Configuration is in `.env` (copy `.env.example`).

```bash
npm test
```

runs the end-to-end test (`test/e2e.mjs`) against a temporary database.

**Deploying** (Docker, Runflare, VPS, ports, env, backups): see [DEPLOY.md](DEPLOY.md).

## User flow

1. **Plan** – pick a subscription plan (`server/config.js`). With `BILLING_MODE=mock` it activates
   instantly without payment; real billing is not wired yet.
2. **Cards** – enter card numbers; the bank is identified from the BIN (`server/banks.js`) and
   validated with Luhn.
3. **Ceiling (سقف کارت به کارت)** – daily receive limit per card: system default
   (`DEFAULT_CARD_LIMIT`), overridable per user and per card. Money received today (Tehran day)
   plus open transactions count against it; new transactions go to the least-used card that still
   has room, or fail with `card_limit_reached`.
4. **Listening sources** – SMS and app notifications are both on by default, nothing to
   configure. The phone forwards only messages that look like a bank deposit; SMS from ordinary
   mobile numbers and chat / mail notifications are ignored. Optionally list SMS sender ids or
   Android package names to restrict a type to exactly those senders (safer).
   Each message's **bank** is identified from its sender / text (and remembered per sender or app
   package), and its **card** from a masked card or account number in the text
   (`server/bankDetect.js`). A message pointing to a different card or bank than the transaction
   with that amount is held back for manual confirmation in the dashboard.
5. **Device** – install the Android app and sign in with the same phone number and password
   as the dashboard; the phone pairs itself. Developers (and the iOS Shortcut) can instead
   create a device token in the "API" tab.
6. **API key + webhook** – integrate.

## JavaScript SDK

`sdk/` is a zero-dependency client (`@paychi/variz`, private) with TypeScript types:
transactions, `waitForPayment`, webhook verification and a `VarizDevice` client for custom
listeners. Full documentation and recipes: [sdk/README.md](sdk/README.md).

```bash
npm install ../paychi-variz/sdk --install-links
```

## Merchant API

Auth: `Authorization: Bearer pk_live_…`. Amounts are integer **Rial**.

| Method | Path | |
|---|---|---|
| POST | `/api/v1/transactions` | `amount` (required), `order_id`, `description`, `callback_url`, `return_url`, `card_id`, `ttl`, `metadata` |
| GET | `/api/v1/transactions/:id` | status: `pending` / `paid` / `expired` / `cancelled` |
| GET | `/api/v1/transactions?order_id=&status=&limit=` | list |
| POST | `/api/v1/transactions/:id/cancel` | |
| GET | `/api/v1/cards` | cards with limit and remaining capacity |

Errors: `{ "error": { "code", "message" } }`.

**Unique amount:** the smallest amount ≥ the requested one (up to `MAX_AMOUNT_DELTA` Rial more)
that no open or recently closed transaction of the same merchant uses.

**Webhooks:** `transaction.paid`, `transaction.expired`, `transaction.cancelled`, sent to the
transaction's `callback_url` or the account webhook URL. Header
`X-Paychi-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(secret, t + "." + rawBody)`.
Non-2xx responses are retried (6 attempts, 10 s → 2 h).

## Listener device API

Auth: `Authorization: Bearer dev_…`

- `POST /api/device/login` (no auth) → body `{ phone, password, device_name?, install_id? }`,
  returns `{ token, device, account }`. The same `install_id` signing in again reuses its device.
- `POST /api/device/pair` (no auth) → body `{ code, device_name?, install_id? }`, same response.
  `code` is the one-time, 10-minute code behind the dashboard's quick-connect QR / link
  (`<origin>/connect#<code>`). That page offers the APK and a `paychi://pair?u=…&c=…` link,
  which the Android app opens and asks the user to confirm before connecting.
- `POST /api/device/logout` → revokes this device's token
- `GET /api/device/config` → `{ account, sms_senders, notification_packages }`
- `POST /api/device/ingest` → body `{ "type": "sms" | "notification", "sender", "body", "received_at"? }`

### Android (`android/`)

Kotlin app with no third-party dependencies: `SmsReceiver` (SMS), `NotifListener`
(notifications), `Forwarder` (HTTP + offline retry queue). A debug-signed build is at
`public/downloads/paychi-listener.apk` (the dashboard shows a download button when that file
exists). **It compiles but has not been run on a phone yet.**

Rebuild (Gradle 9.4.1, Android Gradle Plugin 9.2.1, JDK 17, SDK platform 37):

```bash
cd android && JAVA_HOME=<jdk-17> ANDROID_HOME=<sdk> gradle assembleDebug
```

then copy `android/app/build/outputs/apk/debug/app-debug.apk` to
`public/downloads/paychi-listener.apk`. `android/local.properties` holds `sdk.dir`.

Notes: an app that reads SMS cannot be published on Google Play without their approval, so
distribute the APK directly. On Android 13+ a sideloaded app needs "Allow restricted settings"
(App info → ⋮) before SMS / notification access can be granted.

### iOS (Shortcuts)

iOS does not let apps read SMS, so use a personal automation:

1. Shortcuts → Automation → New → **Message**. Set *Message Contains* to `واریز`, choose
   **Run Immediately**.
2. Add **Get Contents of URL**: URL `<BASE_URL>/api/device/ingest`, method POST,
   header `Authorization: Bearer <device token>`, request body JSON:
   `type` = `sms`, `sender` = Shortcut Input → Sender, `body` = Shortcut Input → Content.

If the dashboard has a sender list, `sender` must equal one of its entries. (Steps written
from the Shortcuts docs; not yet verified on a device.)

## Design systems

- **Web (dashboard, landing, payment page):** Google Material Design 3 by default — colour
  roles, shape, elevation and state layers are tokens at the top of `public/style.css`.
- **Apple devices:** `public/platform.js` detects iPhone / iPad and sets
  `data-platform="ios"`, which switches the same pages to an iOS look (system font and
  colours, grouped cards, tab bar, segmented control).
- Preview either on any device with `?platform=ios` or `?platform=material`;
  `?platform=auto` goes back to detection.
- **Android app:** Material Components 1.12 (`Theme.Material3.DayNight`), same teal scheme.

## Security model

- Payment confirmation trusts the merchant's own device and the sender of the message.
  By default any non-mobile-number SMS sender and any non-chat app notification that parses as
  a deposit can confirm a payment. That is convenient but spoofable by someone who can send
  from a sender name or post a notification on the phone; listing the bank's sender ids in the
  dashboard closes that gap.
- One device token may be used on several phones, but a token per phone lets you revoke one
  phone without touching the others.
- API keys and device tokens are stored hashed (SHA-256) and shown once. Passwords use scrypt.
- Webhook targets on private addresses are blocked when `NODE_ENV=production`.
- Without a sender list, only messages that parse as deposits are stored.

## Before going live

- Real billing for plans; phone-number OTP verification on signup.
- HTTPS + reverse proxy; set `BASE_URL`, `NODE_ENV=production`.
- Collect real SMS samples from each bank and add them to the parser test in `test/e2e.mjs`.
- Check the legal / Shaparak rules that apply to operating a card-to-card payment facilitator
  in your jurisdiction.
