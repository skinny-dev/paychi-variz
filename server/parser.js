// Extracts a deposit amount (in Rial) from an Iranian bank SMS / app notification.

const FA = '۰۱۲۳۴۵۶۷۸۹';
const AR = '٠١٢٣٤٥٦٧٨٩';

export function normalizeDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => FA.indexOf(d))
    .replace(/[٠-٩]/g, (d) => AR.indexOf(d))
    .replace(/[٬]/g, ',')
    .replace(/[‌‎‏‪-‮]/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک');
}

const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d{4,12})';
const toInt = (s) => Number(s.replace(/,/g, ''));

const DEPOSIT_WORDS = /واریز|deposit|credited|افزایش موجودی/i;
const WITHDRAW_WORDS = /برداشت|withdraw|debited|خرید|کسر/i;
const BALANCE_BEFORE = /(مانده|موجودی|balance)[^\d\n]{0,12}$/i;

/**
 * @returns {{ isDeposit: boolean, amount: number | null }}
 */
export function parseBankMessage(raw) {
  const text = normalizeDigits(raw);
  let amount = null;
  let signedPlus = false;
  let m;

  const take = (match, numStr) => {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 10);
    let v = toInt(numStr);
    if (/^\s*تومان/.test(after)) v *= 10;
    return v;
  };

  // 1) "1,000,000+" or "+1,000,000" (not a balance line)
  const plusRe = new RegExp(`(?:\\+\\s*${NUM}(?![\\d,]))|(?:${NUM}\\s*\\+)`, 'g');
  while ((m = plusRe.exec(text))) {
    if (BALANCE_BEFORE.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    amount = take(m, m[1] || m[2]);
    signedPlus = true;
    break;
  }

  // 2) "واریز 1,000,000" / "واریز: 1,000,000" / "واریز مبلغ 1,000,000"
  if (amount == null) {
    m = new RegExp(`واریز(?:ی)?\\s*(?:مبلغ)?\\s*[:：]?\\s*${NUM}(?![\\d,])`).exec(text);
    if (m) amount = take(m, m[1]);
  }

  // 3) "مبلغ: 1,000,000"
  if (amount == null) {
    m = new RegExp(`مبلغ\\s*[:：]?\\s*${NUM}(?![\\d,])`).exec(text);
    if (m) amount = take(m, m[1]);
  }

  // 4) English style: "Deposit 1,000,000" / "amount: 1,000,000"
  if (amount == null) {
    m = new RegExp(`(?:deposit|amount)\\s*[:：]?\\s*${NUM}(?![\\d,])`, 'i').exec(text);
    if (m) amount = take(m, m[1]);
  }

  if (amount == null || !Number.isSafeInteger(amount) || amount <= 0) {
    return { isDeposit: false, amount: null };
  }

  const isDeposit = signedPlus || (DEPOSIT_WORDS.test(text) && !WITHDRAW_WORDS.test(text));
  return { isDeposit, amount };
}
