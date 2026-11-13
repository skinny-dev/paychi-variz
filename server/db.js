import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// All amounts are integer Rial. All timestamps are epoch milliseconds.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  api_key_hash TEXT UNIQUE,
  api_key_prefix TEXT,
  webhook_url TEXT,
  webhook_secret TEXT NOT NULL,
  default_card_limit INTEGER,
  tx_ttl_sec INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  bank_code TEXT NOT NULL,
  holder_name TEXT,
  daily_limit INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, number)
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sms', 'notification')),
  value TEXT NOT NULL,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, type, value)
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  requested_amount INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  order_id TEXT,
  description TEXT,
  callback_url TEXT,
  return_url TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  paid_at INTEGER,
  event_id INTEGER
);
CREATE INDEX IF NOT EXISTS tx_user_status_amount ON transactions (user_id, status, amount);
CREATE INDEX IF NOT EXISTS tx_status_expires ON transactions (status, expires_at);
CREATE INDEX IF NOT EXISTS tx_user_created ON transactions (user_id, created_at);
CREATE INDEX IF NOT EXISTS tx_card ON transactions (card_id, status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER,
  type TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  amount INTEGER,
  is_deposit INTEGER NOT NULL DEFAULT 0,
  tx_id TEXT,
  dedupe TEXT NOT NULL UNIQUE,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user ON events (user_id, received_at);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_id TEXT NOT NULL,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_code INTEGER,
  last_error TEXT,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wh_due ON webhook_deliveries (status, next_at);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);

// Migrations for databases created by earlier versions.
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('devices', 'install_id')) db.exec('ALTER TABLE devices ADD COLUMN install_id TEXT');
// Bank / card identification of incoming messages.
if (!hasColumn('cards', 'account_number')) db.exec('ALTER TABLE cards ADD COLUMN account_number TEXT');
if (!hasColumn('events', 'bank_code')) db.exec('ALTER TABLE events ADD COLUMN bank_code TEXT');
if (!hasColumn('events', 'card_id')) db.exec('ALTER TABLE events ADD COLUMN card_id INTEGER');
if (!hasColumn('events', 'result')) db.exec('ALTER TABLE events ADD COLUMN result TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS sender_banks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sms', 'notification')),
  sender TEXT NOT NULL,            -- SMS sender id or app package name, lower-cased
  bank_code TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 1, -- 1 = learned from a message, 0 = set by the user
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, type, sender)
);
`);

// Merchants: an account (the phone owner) runs any number of merchants (shops, bots, sites).
// Each merchant has its own API key, webhook and transactions, and uses all of the account's
// cards (all_cards = 1) or a chosen subset (merchant_cards). Cards, listener phones, sources and
// incoming messages stay per account, because one phone receives the deposits for every merchant.
db.exec(`
CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  website TEXT,
  api_key_hash TEXT UNIQUE,
  api_key_prefix TEXT,
  webhook_url TEXT,
  webhook_secret TEXT NOT NULL,
  tx_ttl_sec INTEGER,
  all_cards INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS merchants_user ON merchants (user_id);
CREATE TABLE IF NOT EXISTS merchant_cards (
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  PRIMARY KEY (merchant_id, card_id)
);
`);
if (!hasColumn('transactions', 'merchant_id')) {
  db.exec('ALTER TABLE transactions ADD COLUMN merchant_id INTEGER REFERENCES merchants(id)');
}
if (!hasColumn('webhook_deliveries', 'merchant_id')) {
  db.exec('ALTER TABLE webhook_deliveries ADD COLUMN merchant_id INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS tx_merchant_created ON transactions (merchant_id, created_at)');
// Accounts from before merchants existed: their API key, webhook and transactions become the
// account's first merchant, so existing integrations keep working unchanged.
for (const u of db.prepare(
  'SELECT * FROM users WHERE NOT EXISTS (SELECT 1 FROM merchants m WHERE m.user_id = users.id)',
).all()) {
  db.exec('BEGIN');
  try {
    const m = db.prepare(
      `INSERT INTO merchants (user_id, name, api_key_hash, api_key_prefix, webhook_url, webhook_secret, tx_ttl_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(u.id, 'فروشگاه اصلی', u.api_key_hash, u.api_key_prefix, u.webhook_url, u.webhook_secret, u.tx_ttl_sec, Date.now());
    const mid = Number(m.lastInsertRowid);
    db.prepare('UPDATE transactions SET merchant_id = ? WHERE user_id = ? AND merchant_id IS NULL').run(mid, u.id);
    db.prepare('UPDATE webhook_deliveries SET merchant_id = ? WHERE user_id = ? AND merchant_id IS NULL').run(mid, u.id);
    db.prepare('UPDATE users SET api_key_hash = NULL, api_key_prefix = NULL WHERE id = ?').run(u.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Payment links: a shareable page (/l/<slug>) where a payer starts a transaction of a merchant
// without any integration. amount NULL = the payer enters the amount (within min/max).
db.exec(`
CREATE TABLE IF NOT EXISTS payment_links (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  amount INTEGER,
  min_amount INTEGER,
  max_amount INTEGER,
  ask_payer INTEGER NOT NULL DEFAULT 0,   -- ask the payer for name + phone
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_merchant ON payment_links (merchant_id);
`);
if (!hasColumn('transactions', 'link_id')) db.exec('ALTER TABLE transactions ADD COLUMN link_id INTEGER');

// Telegram alerts: chats that get a message when a payment arrives (or is held for confirmation).
// merchant_id NULL = every merchant of the account.
db.exec(`
CREATE TABLE IF NOT EXISTS notify_channels (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  title TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notify_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);

const cache = new Map();
/** Cached prepared statement. */
export function q(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

/** Run fn inside a write transaction. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
