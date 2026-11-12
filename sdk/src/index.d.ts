// Type definitions for @paychi/variz

export type TransactionStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface ClientOptions {
  /** Server address, e.g. "https://pay.example.com". */
  baseUrl: string;
  /** Request timeout in milliseconds. Default 15000. */
  timeout?: number;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface TransactionCard {
  id: number;
  /** 16-digit card number the payer must transfer to. */
  number: string;
  /** Bank code, e.g. "mellat". */
  bank: string;
  /** Bank name in Persian, e.g. "بانک ملت". */
  bank_name: string;
  holder_name: string | null;
}

export interface Transaction {
  /** Unique id, e.g. "tx_k3m9…". */
  id: string;
  status: TransactionStatus;
  /** Unique amount in Rial the payer must transfer exactly. */
  amount: number;
  /** Amount you asked for, in Rial. */
  requested_amount: number;
  currency: 'IRR';
  order_id: string | null;
  description: string | null;
  card: TransactionCard;
  /** Hosted payment page (bank-styled card, exact amount, countdown). */
  payment_url: string;
  return_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
}

export interface CreateTransactionParams {
  /** Amount in Rial (minimum 10,000). The response amount may be a few Rial higher to be unique. */
  amount: number;
  /** Your own reference; searchable with transactions.list({ order_id }). */
  order_id?: string;
  description?: string;
  /** Webhook URL for this transaction only (overrides the account webhook). */
  callback_url?: string;
  /** Where the payment page sends the payer afterwards (?tx_id=…&status=… is appended). */
  return_url?: string;
  /** Force a specific card. Default: the least-used card that still has room under its daily limit. */
  card_id?: number;
  /** Seconds the payer has to pay. Default set in the dashboard. */
  ttl?: number;
  /** Any JSON object, returned with the transaction and in webhooks. */
  metadata?: Record<string, unknown>;
}

export interface ListTransactionsParams {
  order_id?: string;
  status?: TransactionStatus;
  /** 1–100, default 20. */
  limit?: number;
}

export interface WaitOptions extends RequestOptions {
  /** Poll interval in ms. Default 3000. */
  interval?: number;
  /** Give up after this many ms (throws VarizError code "timeout"). Default: wait until the transaction ends. */
  timeout?: number;
}

export interface Card {
  id: number;
  number: string;
  bank: string;
  bank_name: string;
  holder_name: string | null;
  active: boolean;
  /** Daily card-to-card limit in Rial. */
  daily_limit: number;
  daily_limit_is_custom: boolean;
  received_today: number;
  /** Rial reserved by pending transactions. */
  reserved: number;
  remaining_today: number;
  /** Optional account number, used to recognise SMS that name the account instead of the card. */
  account_number: string | null;
}

export class VarizError extends Error {
  /** HTTP status (0 for network errors and timeouts). */
  status: number;
  /** API error code, e.g. "card_limit_reached", "subscription_required", "timeout", "network_error". */
  code: string;
}

export class Variz {
  constructor(options: ClientOptions & { apiKey: string });
  transactions: {
    create(params: CreateTransactionParams, options?: RequestOptions): Promise<Transaction>;
    get(id: string, options?: RequestOptions): Promise<Transaction>;
    list(params?: ListTransactionsParams, options?: RequestOptions): Promise<Transaction[]>;
    cancel(id: string, options?: RequestOptions): Promise<Transaction>;
    /** Resolves once the transaction is paid, expired or cancelled. */
    waitForPayment(id: string, options?: WaitOptions): Promise<Transaction>;
  };
  cards: {
    list(options?: RequestOptions): Promise<Card[]>;
  };
}
export default Variz;

export interface DeviceConfig {
  device: { id: number; name: string };
  account: { name: string | null; phone: string };
  /** Empty = any bank sender is accepted. */
  sms_senders: string[];
  notification_packages: string[];
}

export interface IngestMessage {
  type?: 'sms' | 'notification';
  /** SMS sender id or app package name. */
  sender: string;
  /** Full message text. */
  body: string;
  /** Epoch ms; used to de-duplicate the same message sent twice. */
  received_at?: number;
}

export interface IngestResult {
  accepted: boolean;
  matched: boolean;
  duplicate?: boolean;
  amount?: number;
  /** The matched transaction, or (for card_mismatch / bank_mismatch) the one with that amount. */
  transaction_id?: string;
  /**
   * Why it did not match: "not_a_deposit", "source_not_allowed", "sender_is_mobile_number",
   * "no_pending_transaction", "bank_mismatch" (message is from another bank than the
   * transaction's card), "card_mismatch" (message names another of your cards).
   */
  reason?: string;
  /** Bank the message was identified as coming from (e.g. "mellat"), or null. */
  bank?: string | null;
  /** Your card the message names (by card or account number), or null. */
  card_id?: number | null;
}

export interface DeviceSession {
  /** Ready-to-use client for this device. */
  device: VarizDevice;
  /** The device as stored on the server. */
  info: { id: number; name: string };
  token: string;
  account: { name: string | null; phone: string };
}

export class VarizDevice {
  constructor(options: ClientOptions & { token: string });
  config(options?: RequestOptions): Promise<DeviceConfig>;
  ingest(message: IngestMessage, options?: RequestOptions): Promise<IngestResult>;
  logout(options?: RequestOptions): Promise<{ ok: true }>;
  /** Redeem a quick-connect code; `code` may also be the full "https://…/connect#code" link. */
  static pair(options: Partial<ClientOptions> & { code: string; deviceName?: string; installId?: string }): Promise<DeviceSession>;
  static login(options: ClientOptions & { phone: string; password: string; deviceName?: string; installId?: string }): Promise<DeviceSession>;
}

export type WebhookEventType = 'transaction.paid' | 'transaction.expired' | 'transaction.cancelled';

export interface WebhookEvent {
  event: WebhookEventType;
  created_at: string;
  data: Transaction;
}

/** Verify the X-Paychi-Signature header and return the parsed event. Throws VarizError if invalid. */
export function verifyWebhook(
  rawBody: string | ArrayBuffer | ArrayBufferView,
  signatureHeader: string | null | undefined,
  secret: string,
  options?: { tolerance?: number },
): Promise<WebhookEvent>;

/** Produce a signature header value (for tests). */
export function signWebhook(rawBody: string | ArrayBuffer | ArrayBufferView, secret: string, timestamp?: number): Promise<string>;
