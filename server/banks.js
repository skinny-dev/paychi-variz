// Iranian bank identification by card BIN (first 6 digits).
// `colors` drive the card design on the payment page.
export const banks = {
  melli: { name: 'بانک ملی ایران', colors: ['#0b3d91', '#1f6feb'] },
  sepah: { name: 'بانک سپه', colors: ['#1c2a4a', '#f2a900'] },
  saderat: { name: 'بانک صادرات ایران', colors: ['#1a2a6c', '#3b5bdb'] },
  mellat: { name: 'بانک ملت', colors: ['#c8102e', '#7a0019'] },
  tejarat: { name: 'بانک تجارت', colors: ['#0a3a7a', '#2f80ed'] },
  keshavarzi: { name: 'بانک کشاورزی', colors: ['#1b5e20', '#8d9f1c'] },
  maskan: { name: 'بانک مسکن', colors: ['#e65100', '#b23c00'] },
  refah: { name: 'بانک رفاه کارگران', colors: ['#143a8c', '#1e9bd7'] },
  postbank: { name: 'پست بانک ایران', colors: ['#1b6b3a', '#f2b705'] },
  tosee_taavon: { name: 'بانک توسعه تعاون', colors: ['#0d7a7a', '#14b8a6'] },
  tosee_saderat: { name: 'بانک توسعه صادرات', colors: ['#2e6b2e', '#7fb069'] },
  sanat_madan: { name: 'بانک صنعت و معدن', colors: ['#12355b', '#c9a227'] },
  eghtesad_novin: { name: 'بانک اقتصاد نوین', colors: ['#5b2a86', '#9b5de5'] },
  parsian: { name: 'بانک پارسیان', colors: ['#7a1420', '#b8860b'] },
  pasargad: { name: 'بانک پاسارگاد', colors: ['#1a1a1a', '#c9a227'] },
  karafarin: { name: 'بانک کارآفرین', colors: ['#1d5b2f', '#3fa34d'] },
  saman: { name: 'بانک سامان', colors: ['#0e86d4', '#055c9d'] },
  sina: { name: 'بانک سینا', colors: ['#17306b', '#f0b429'] },
  sarmayeh: { name: 'بانک سرمایه', colors: ['#3a3a3a', '#8a6d3b'] },
  shahr: { name: 'بانک شهر', colors: ['#c1121f', '#780000'] },
  dey: { name: 'بانک دی', colors: ['#00695c', '#26a69a'] },
  ayandeh: { name: 'بانک آینده', colors: ['#4e342e', '#a47148'] },
  gardeshgari: { name: 'بانک گردشگری', colors: ['#8e1b3a', '#d6336c'] },
  iran_zamin: { name: 'بانک ایران زمین', colors: ['#5c2d91', '#2d7d46'] },
  resalat: { name: 'بانک قرض‌الحسنه رسالت', colors: ['#00695c', '#1e88e5'] },
  mehr_iran: { name: 'بانک قرض‌الحسنه مهر ایران', colors: ['#2e7d32', '#66bb6a'] },
  khavarmianeh: { name: 'بانک خاورمیانه', colors: ['#ef6c00', '#37474f'] },
  melal: { name: 'مؤسسه اعتباری ملل', colors: ['#1565c0', '#2e7d32'] },
  noor: { name: 'مؤسسه اعتباری نور', colors: ['#f9a825', '#6d4c41'] },
  iran_venezuela: { name: 'بانک ایران و ونزوئلا', colors: ['#283593', '#c62828'] },
  unknown: { name: 'بانک نامشخص', colors: ['#334155', '#64748b'] },
};

const bins = {
  603799: 'melli',
  589210: 'sepah',
  627381: 'sepah', // انصار (ادغام در سپه)
  639370: 'sepah', // مهر اقتصاد (ادغام در سپه)
  639599: 'sepah', // قوامین (ادغام در سپه)
  636949: 'sepah', // حکمت ایرانیان (ادغام در سپه)
  505801: 'sepah', // کوثر (ادغام در سپه)
  603769: 'saderat',
  610433: 'mellat',
  991975: 'mellat',
  627353: 'tejarat',
  585983: 'tejarat',
  603770: 'keshavarzi',
  639217: 'keshavarzi',
  628023: 'maskan',
  589463: 'refah',
  627760: 'postbank',
  502908: 'tosee_taavon',
  627648: 'tosee_saderat',
  207177: 'tosee_saderat',
  627961: 'sanat_madan',
  627412: 'eghtesad_novin',
  622106: 'parsian',
  639194: 'parsian',
  502229: 'pasargad',
  639347: 'pasargad',
  627488: 'karafarin',
  502910: 'karafarin',
  621986: 'saman',
  639346: 'sina',
  639607: 'sarmayeh',
  502806: 'shahr',
  504706: 'shahr',
  502938: 'dey',
  636214: 'ayandeh',
  505416: 'gardeshgari',
  505785: 'iran_zamin',
  504172: 'resalat',
  606373: 'mehr_iran',
  585947: 'khavarmianeh',
  606256: 'melal',
  507677: 'noor',
  581874: 'iran_venezuela',
};

export function luhnValid(number) {
  if (!/^\d{16}$/.test(number)) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    let d = number.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function bankCodeOf(number) {
  return bins[number.slice(0, 6)] || 'unknown';
}

export function bankInfo(code) {
  const b = banks[code] || banks.unknown;
  return { code: banks[code] ? code : 'unknown', name: b.name, colors: b.colors };
}

/** Data the browser needs to identify a bank while the user types. */
export const clientBankTable = { banks, bins };
