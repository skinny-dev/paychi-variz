const int = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
};

const port = int('PORT', 3000);

export const config = {
  port,
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  dbPath: process.env.DB_PATH || './data/paychi.db',
  billingMode: process.env.BILLING_MODE || 'mock',
  defaultCardLimit: int('DEFAULT_CARD_LIMIT', 100_000_000),
  txTtlSec: int('TX_TTL_SEC', 600),
  txMinTtlSec: int('TX_MIN_TTL_SEC', 60),
  txMaxTtlSec: int('TX_MAX_TTL_SEC', 3600),
  maxAmountDelta: int('MAX_AMOUNT_DELTA', 500),
  graceSec: int('GRACE_SEC', 60),
  amountCooldownSec: int('AMOUNT_COOLDOWN_SEC', 1800),
  minAmount: 10_000,
  apkUrl: process.env.APK_URL || '',
  // When set, signing up needs this invite code (keeps a private deployment private).
  signupCode: process.env.SIGNUP_CODE || '',
  production: process.env.NODE_ENV === 'production',
  allowPrivateWebhooks:
    process.env.ALLOW_PRIVATE_WEBHOOKS === '1' || process.env.NODE_ENV !== 'production',
};

// Prices are in Rial per 30 days. Placeholder numbers — set your own.
export const plans = [
  { id: 'starter', name: 'پایه', price: 2_900_000, days: 30, maxCards: 2, maxTxPerPeriod: 500 },
  { id: 'pro', name: 'حرفه‌ای', price: 7_900_000, days: 30, maxCards: 10, maxTxPerPeriod: 5000 },
  { id: 'business', name: 'سازمانی', price: 19_900_000, days: 30, maxCards: 50, maxTxPerPeriod: null },
];

export const planById = (id) => plans.find((p) => p.id === id) || null;
