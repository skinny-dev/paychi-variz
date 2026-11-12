// Works out which bank (and, when the text says so, which of the user's cards) a deposit
// SMS / app notification belongs to.
import { normalizeDigits } from './parser.js';

/**
 * Names as they appear in bank SMS and notification titles. Persian names must follow "بانک"
 * (or "مؤسسه اعتباری") because many of them are everyday words (شهر، آینده، دی، ملل …).
 * Longer names come first so "توسعه صادرات" wins over "صادرات".
 */
const NAMES = [
  ['tosee_saderat', ['توسعه صادرات'], ['edbi', 'export development bank']],
  ['tosee_taavon', ['توسعه تعاون'], ['tose[e]?h? ?taavon']],
  ['sanat_madan', ['صنعت و معدن', 'صنعت ومعدن'], ['bim\\b', 'industry and mine']],
  ['eghtesad_novin', ['اقتصاد نوین'], ['en ?bank', 'eghtesad ?novin']],
  ['iran_zamin', ['ایران زمین', 'ایران‌زمین'], ['iran ?zamin']],
  ['iran_venezuela', ['ایران و ونزوئلا'], ['iran.?venezuela']],
  ['mehr_iran', ['مهر ایران', 'قرض الحسنه مهر', 'قرض‌الحسنه مهر'], ['mehr ?iran', 'qmb']],
  ['resalat', ['رسالت', 'قرض الحسنه رسالت', 'قرض‌الحسنه رسالت'], ['resalat']],
  ['khavarmianeh', ['خاورمیانه'], ['middle ?east ?bank', 'khavarmianeh']],
  ['postbank', [], ['post ?bank']],
  ['melli', ['ملی', 'ملی ایران'], ['bank ?melli', 'melli ?bank', 'bmi\\b']],
  ['mellat', ['ملت'], ['mellat']],
  ['sepah', ['سپه'], ['sepah']],
  ['saderat', ['صادرات', 'صادرات ایران'], ['saderat', 'bsi\\b']],
  ['tejarat', ['تجارت'], ['tejarat']],
  ['keshavarzi', ['کشاورزی'], ['keshavarzi', 'agri ?bank']],
  ['maskan', ['مسکن'], ['maskan']],
  ['refah', ['رفاه', 'رفاه کارگران'], ['refah']],
  ['parsian', ['پارسیان'], ['parsian']],
  ['pasargad', ['پاسارگاد'], ['pasargad', 'bpi\\b']],
  ['karafarin', ['کارآفرین', 'کار آفرین'], ['karafarin']],
  ['saman', ['سامان'], ['saman']],
  ['sina', ['سینا'], ['sina ?bank', 'bank ?sina']],
  ['sarmayeh', ['سرمایه'], ['sarmayeh']],
  ['shahr', ['شهر'], ['shahr ?bank', 'bank ?shahr', 'city ?bank']],
  ['dey', ['دی'], ['dey ?bank', 'bank ?dey', 'day ?bank']],
  ['ayandeh', ['آینده'], ['ayandeh']],
  ['gardeshgari', ['گردشگری'], ['gardeshgari', 'tourism ?bank']],
  ['melal', ['ملل'], ['melal']],
  ['noor', ['نور'], ['noor ?(credit|bank)']],
];

const PATTERNS = NAMES.map(([code, fa, en]) => {
  const parts = [];
  if (fa.length) {
    // "بانک ملت", "بانك ملت", "مؤسسه اعتباری ملل" — the next char must not continue the word.
    parts.push(`(?:بانک|موسسه اعتباری|مؤسسه اعتباری)\\s*(?:${fa.map((n) => n.replace(/ /g, '\\s*')).join('|')})(?![\\u0600-\\u06FF])`);
  }
  if (code === 'postbank') parts.push('پست\\s*بانک');
  for (const e of en) parts.push(`\\b${e}`);
  return { code, re: new RegExp(parts.join('|'), 'gi') };
});

function banksIn(text) {
  const found = new Map(); // code -> first index
  let t = text;
  for (const { code, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      // "از بانک ملی" / "from Bank Melli" names the payer's bank, not the one that received the money.
      const before = t.slice(Math.max(0, m.index - 8), m.index);
      if (!/(?:^|[\s:])(?:از|from)\s*$/i.test(before) && !found.has(code)) found.set(code, m.index);
      // Blank out the match so a shorter name inside it ("صادرات" in "توسعه صادرات") is not counted again.
      t = t.slice(0, m.index) + ' '.repeat(m[0].length) + t.slice(m.index + m[0].length);
      re.lastIndex = m.index + m[0].length;
    }
  }
  return found;
}

/**
 * The bank a message is from, or null when unclear. The sender name and the first line (where
 * banks put their name) decide; a message that names several banks elsewhere (e.g. "transfer
 * from Bank Melli" inside a Mellat SMS) is only trusted if one bank is clearly in front.
 */
export function detectBank(sender, body) {
  const s = normalizeDigits(sender ?? '');
  const text = normalizeDigits(body ?? '');
  const fromSender = banksIn(s);
  if (fromSender.size === 1) return [...fromSender.keys()][0];
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  const head = banksIn(firstLine);
  if (head.size === 1) return [...head.keys()][0];
  const all = banksIn(text);
  return all.size === 1 ? [...all.keys()][0] : null;
}

/**
 * Card or account references in the text, e.g. "کارت 6104-33**-****-4567", "حساب ****1234",
 * "به 0101234567". Only numbers marked as masked or labelled as card / account count, so
 * amounts and balances are never mistaken for an account.
 * @returns {{ digits: string, masked: boolean }[]}
 */
export function cardRefs(body) {
  const text = normalizeDigits(body ?? '');
  const refs = [];
  const re = /(کارت|حساب|سپرده|card|acc(?:ount)?\.?|به|از)?\s*[:：]?\s*([\d*•xX][\d*•xX\-.\s]{2,30}[\d])/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[2].trim();
    const masked = /[*•xX]/.test(raw);
    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length < 4 || /,/.test(raw)) continue;
    if (!masked && !m[1]) continue;
    refs.push({ digits, masked });
  }
  return refs;
}

/**
 * Which of `cards` the text points to, or null. A masked reference matches on its last 4
 * digits; an unmasked one must equal the card number or the card's account number.
 */
export function identifyCard(body, cards) {
  const refs = cardRefs(body);
  if (!refs.length) return null;
  const hits = new Set();
  for (const card of cards) {
    const acct = (card.account_number || '').replace(/\D/g, '');
    for (const r of refs) {
      if (r.masked) {
        const tail = r.digits.slice(-4);
        if (r.digits.length >= 4 && (card.number.endsWith(tail) || (acct && acct.endsWith(tail)))) hits.add(card.id);
      } else if (r.digits === card.number || (acct.length >= 6 && r.digits === acct)) {
        hits.add(card.id);
      }
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}
