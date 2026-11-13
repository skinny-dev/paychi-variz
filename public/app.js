// Dashboard SPA (no build step). All user-provided text goes through esc().
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const state = { me: null, banks: null, tab: 'overview', flash: {}, txFilter: '', txMerchant: '' };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fa = (n) => Number(n ?? 0).toLocaleString('fa-IR');
const rial = (n) => `${fa(n)} ریال`;
const toman = (n) => `${fa(Math.floor(n / 10))} تومان`;
const date = (iso) => (iso ? new Date(iso).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const toEn = (s) =>
  String(s ?? '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const digits = (s) => toEn(s).replace(/\D/g, '');
const numOrNull = (s) => (digits(s) ? Number(digits(s)) : null);
const groupCard = (n) => String(n).replace(/(\d{4})(?=\d)/g, '$1 ');
const STATUS = { pending: 'در انتظار', paid: 'پرداخت‌شده', expired: 'منقضی', cancelled: 'لغو شده', ok: 'موفق', failed: 'ناموفق' };
const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS[s] || s)}</span>`;

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.innerHTML = `<div class="${isErr ? 'err' : ''}">${esc(msg)}</div>`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.innerHTML = ''), 3500);
}

async function api(method, path, body) {
  const res = await fetch('/api/dash' + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = '/';
    throw new Error('نیاز به ورود');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || 'خطای سرور');
  return json;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('کپی شد');
}

const bankOf = (number) => {
  const code = state.banks.bins[String(number).slice(0, 6)] || 'unknown';
  return { code, ...(state.banks.banks[code] || state.banks.banks.unknown) };
};
const bankCard = (number, holder, { off = false } = {}) => {
  const b = bankOf(number);
  return `<div class="bankcard ${off ? 'off' : ''}" style="--c1:${esc(b.colors[0])};--c2:${esc(b.colors[1])}">
    <div class="spread"><span class="bname">${esc(b.name)}</span><span class="chip"></span></div>
    <div class="num">${esc(groupCard(String(number).padEnd(16, '•')))}</div>
    <div class="holder">${esc(holder || '')}&nbsp;</div>
  </div>`;
};
const head = (title, extra = '') => `<div class="head"><h1>${esc(title)}</h1><div class="row">${extra}</div></div>`;
const merchantOptions = (selected, { all = false } = {}) =>
  (all ? `<option value="">همه فروشگاه‌ها</option>` : '')
  + state.me.merchants.filter((m) => m.active || String(m.id) === String(selected))
    .map((m) => `<option value="${m.id}" ${String(m.id) === String(selected) ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
const needPlan = () =>
  state.me.subscription ? '' : `<div class="note warn">برای ادامه ابتدا یک پلن اشتراک فعال کنید. <a href="#plan">انتخاب پلن</a></div>`;

// ------------------------------------------------------------------ quick connect
const isLocalHost = /^(localhost|127\.|\[::1\])/.test(location.hostname);
const onAndroid = /Android/i.test(navigator.userAgent);

/** One pairing code is kept and reused until shortly before it expires. */
async function ensurePair(force = false) {
  const p = state.pair;
  if (force || !p || new Date(p.expires_at).getTime() - Date.now() < 60_000) {
    state.pair = await api('POST', '/pairing', { origin: location.origin });
  }
  return state.pair;
}

/** QR + link (and, on an Android phone, a one-tap button). The page watches for the phone and updates itself. */
function quickConnect(pair) {
  const code = pair.url.split('#')[1];
  const deep = `paychi://pair?u=${encodeURIComponent(pair.url.split('/connect#')[0])}&c=${encodeURIComponent(code)}`;
  const apk = state.me.apk_available
    ? `<a class="btn tonal" href="/downloads/paychi-listener.apk">دانلود اپ</a>` : '';
  return `
    ${onAndroid ? `<div class="row" style="margin-bottom:12px">
        <a class="btn" href="${esc(deep)}">اتصال همین گوشی</a>${apk}
      </div><p class="small muted">یا برای اتصال یک گوشی دیگر، این کد را با آن اسکن کنید:</p>` : ''}
    <div class="qrbox">
      <div class="qr">${pair.qr_svg}</div>
      <div style="flex:1 1 200px">
        <ol style="margin-bottom:8px">
          <li>اپ را روی گوشی باز کنید و <b>«اسکن QR داشبورد»</b> را بزنید.</li>
          <li>این کد را اسکن کنید. تمام!</li>
        </ol>
        <p class="small muted">اپ را ندارید؟ همین کد را با دوربین گوشی اسکن کنید تا صفحه نصب باز شود.</p>
        <div class="row">
          <button class="btn ghost sm" data-act="copy" data-text="${esc(pair.url)}">کپی لینک اتصال</button>
          ${onAndroid ? '' : apk.replace('class="btn tonal"', 'class="btn tonal sm"')}
          <button class="btn ghost sm" data-act="pairQr">کد جدید</button>
        </div>
      </div>
    </div>
    <div class="secret" style="margin-bottom:8px">${esc(pair.url)}</div>
    <div class="small muted"><span class="pulse"></span>در انتظار اتصال گوشی… این صفحه خودش به‌روز می‌شود.</div>
    ${/\/\/(localhost|127\.|\[::1\])/.test(pair.url) ? `<div class="note warn" style="margin:12px 0 0">این کامپیوتر به شبکه‌ای وصل نیست؛
      گوشی به آدرس localhost دسترسی ندارد.</div>`
      : isLocalHost ? `<div class="note" style="margin:12px 0 0">حالت آزمایشی: گوشی باید به <b>همان وای‌فای</b> این کامپیوتر وصل باشد.
      اگر صفحه در گوشی باز نشد، فایروال ویندوز پورت سرور را بسته است.</div>` : ''}`;
}

/** While a quick-connect code is on screen, notice the phone as soon as it connects. */
function watchForDevice(active) {
  clearInterval(state.watch);
  if (!active) return;
  // A device counts as newly connected when its token is one we have not seen (new phone or re-paired phone).
  let known = null;
  state.watch = setInterval(async () => {
    try {
      const { devices } = await api('GET', '/devices');
      const fresh = known && devices.find((d) => !known.has(d.id + d.token_prefix));
      known = new Set(devices.map((d) => d.id + d.token_prefix));
      if (fresh) {
        clearInterval(state.watch);
        state.pair = null;
        toast(`گوشی «${fresh.name}» وصل شد ✓`);
        await reload();
      }
    } catch { /* keep watching */ }
  }, 3000);
}

const RESULT = {
  not_a_deposit: 'واریز نیست',
  no_pending_transaction: 'بدون تراکنش منطبق',
  bank_mismatch: 'بانک دیگر',
  card_mismatch: 'کارت دیگر',
  confirmed_manually: 'تأیید دستی',
};
function eventResult(e) {
  if (e.tx_id) return badge('paid') + (e.result === 'confirmed_manually' ? `<div class="small muted">${RESULT.confirmed_manually}</div>` : '');
  const label = RESULT[e.result] || (e.is_deposit ? RESULT.no_pending_transaction : RESULT.not_a_deposit);
  const canConfirm = e.is_deposit && e.amount && ['bank_mismatch', 'card_mismatch'].includes(e.result);
  return `<span class="badge ${canConfirm ? 'pending' : ''}">${esc(label)}</span>`
    + (canConfirm ? `<div style="margin-top:6px"><button class="btn tonal sm" data-act="confirmEvent" data-id="${e.id}">تأیید دستی</button></div>` : '');
}

const STATUS_OK = (d) => `${badge(d.status)} <span class="small muted ltr">${esc(d.last_error || d.last_code || '')}</span>`;
function deliveriesTable(deliveries, { merchant = true } = {}) {
  if (!deliveries.length) return `<div class="empty">هنوز وب‌هوکی ارسال نشده است.</div>`;
  return `<div class="tablewrap"><table><tr><th>زمان</th>${merchant ? '<th>فروشگاه</th>' : ''}<th>رویداد</th><th>تراکنش</th><th>آدرس</th><th>تلاش</th><th>وضعیت</th></tr>
    ${deliveries.map((d) => `<tr><td class="nowrap small">${date(d.created_at)}</td>
      ${merchant ? `<td class="small">${esc(d.merchant_name || '—')}</td>` : ''}
      <td class="ltr mono small">${esc(d.event)}</td><td class="ltr mono small">${esc(d.tx_id)}</td>
      <td class="ltr small">${esc(d.url)}</td><td>${fa(d.attempts)}</td><td>${STATUS_OK(d)}</td></tr>`).join('')}</table></div>`;
}
const last4 = (n) => String(n).slice(-4);

// ------------------------------------------------------------------ views
const views = {
  async overview() {
    const { me } = state;
    const c = me.counts;
    const sub = me.subscription;
    const pair = c.devices === 0 ? await ensurePair() : null;
    const internal = me.billing_mode === 'off';
    const steps = [
      ...(internal ? [] : [[!!sub, 'انتخاب پلن اشتراک', 'plan']]),
      [c.cards > 0, 'ثبت شماره کارت', 'cards'],
      [c.devices > 0, 'اتصال گوشی (اندروید یا شورتکات iOS)', 'listen'],
      [me.merchants.some((m) => m.api_key_prefix), 'ساخت فروشگاه، کلید API و وب‌هوک', 'merchants'],
    ];
    return `${head('نمای کلی')}
      <div class="grid g4" style="margin-bottom:16px">
        <div class="stat"><b>${fa(c.paid)}</b><span>تراکنش موفق</span></div>
        <div class="stat"><b>${toman(c.paid_sum)}</b><span>مجموع دریافتی</span></div>
        <div class="stat"><b>${fa(c.pending)}</b><span>در انتظار پرداخت</span></div>
        ${internal
          ? `<div class="stat"><b>${fa(me.merchants.filter((m) => m.active).length)}</b><span>فروشگاه فعال</span></div>`
          : `<div class="stat"><b>${sub ? esc(sub.plan.name) : '—'}</b><span>${sub ? `اعتبار تا ${date(sub.expires_at)}` : 'بدون اشتراک'}</span></div>`}
      </div>
      ${pair ? `<div class="card"><h2>اتصال سریع گوشی</h2>${quickConnect(pair)}</div>` : ''}
      <div class="grid g2">
        <div class="card"><h2>راه‌اندازی</h2>
          <ul class="steps">${steps.map(([done, label, tab], i) =>
            `<li><span class="dot ${done ? 'done' : ''}">${done ? '✓' : fa(i + 1)}</span><a href="#${tab}">${esc(label)}</a></li>`).join('')}</ul>
        </div>
        <div class="card"><h2>تراکنش آزمایشی</h2>
          <p class="muted small">یک تراکنش بسازید و صفحه پرداخت را ببینید (همان کاری که API انجام می‌دهد).</p>
          <form data-form="testTx" class="row">
            <div class="field"><label>فروشگاه</label><select name="merchant_id">${merchantOptions('')}</select></div>
            <div class="field"><label>مبلغ (ریال)</label><input name="amount" class="ltr" inputmode="numeric" value="1500000" required></div>
            <button class="btn" >ساخت تراکنش</button>
          </form>
          ${state.flash.tx ? `<div class="note">مبلغ یکتا: <b>${rial(state.flash.tx.amount)}</b> —
            <a href="${esc(state.flash.tx.payment_url)}" target="_blank" rel="noopener">باز کردن صفحه پرداخت</a></div>` : ''}
        </div>
      </div>`;
  },

  async plan() {
    const { plans, billing_mode: mode } = await api('GET', '/plans');
    const sub = state.me.subscription;
    if (mode === 'off') {
      return `${head('اشتراک')}<div class="note">این نسخه برای استفاده داخلی است: اشتراک لازم نیست و محدودیتی ندارد.</div>`;
    }
    return `${head('اشتراک')}
      ${mode === 'mock' ? `<div class="note warn">حالت آزمایشی: پلن بدون پرداخت و فوری فعال می‌شود.</div>` : ''}
      ${sub ? `<div class="note">پلن فعال: <b>${esc(sub.plan.name)}</b> — تا ${date(sub.expires_at)} —
        مصرف: ${fa(sub.tx_used)}${sub.plan.maxTxPerPeriod ? ` از ${fa(sub.plan.maxTxPerPeriod)}` : ''} تراکنش</div>` : ''}
      <div class="grid g3">${plans.map((p) => `
        <div class="card">
          <h2>${esc(p.name)}</h2>
          <p><b style="font-size:1.3rem">${toman(p.price)}</b> <span class="muted small">/ ${fa(p.days)} روز</span></p>
          <ul class="steps small">
            <li>تا ${fa(p.maxCards)} کارت بانکی</li>
            <li>${p.maxTxPerPeriod ? `${fa(p.maxTxPerPeriod)} تراکنش در دوره` : 'تراکنش نامحدود'}</li>
            <li>API، وب‌هوک و صفحه پرداخت</li>
          </ul>
          <button class="btn block ${sub?.plan.id === p.id ? 'tonal' : ''}" style="margin-top:12px" data-act="subscribe" data-id="${esc(p.id)}">
            ${sub?.plan.id === p.id ? 'تمدید' : 'انتخاب پلن'}</button>
        </div>`).join('')}</div>`;
  },

  async cards() {
    const { cards } = await api('GET', '/cards');
    const { settings, defaults } = state.me;
    const userDefault = settings.default_card_limit ?? defaults.card_limit;
    return `${head('کارت‌ها و سقف کارت به کارت')}${needPlan()}
      <div class="grid g2">
        <div class="card"><h2>افزودن کارت</h2>
          <form data-form="addCard">
            <div id="card-preview" style="margin-bottom:14px">${bankCard('', '')}</div>
            <div class="field"><label>شماره کارت (بانک به‌صورت خودکار شناسایی می‌شود)</label>
              <input name="number" class="ltr mono" inputmode="numeric" maxlength="19" placeholder="6104 3377 0000 0000" data-cardinput required></div>
            <div class="field"><label>نام صاحب کارت</label><input name="holder_name" data-holderinput></div>
            <div class="field"><label>سقف روزانه این کارت (ریال) — خالی = پیش‌فرض ${rial(userDefault)}</label>
              <input name="daily_limit" class="ltr" inputmode="numeric"></div>
            <div class="field"><label>شماره حساب (اختیاری) — برای بانک‌هایی که در پیامک به‌جای کارت، شماره حساب می‌نویسند</label>
              <input name="account_number" class="ltr mono" inputmode="numeric"></div>
            <button class="btn">ثبت کارت</button>
          </form>
        </div>
        <div class="card"><h2>سقف پیش‌فرض</h2>
          <p class="muted small">سقف روزانه دریافت برای هر کارت. وقتی مجموع دریافتی امروز و تراکنش‌های باز یک کارت به سقف برسد،
            تراکنش جدید به کارت دیگری می‌رود. برای هر کارت می‌توانید سقف جداگانه تعیین کنید.</p>
          <form data-form="defaultLimit" class="row">
            <div class="field"><label>سقف پیش‌فرض شما (ریال) — خالی = پیش‌فرض سیستم ${rial(defaults.card_limit)}</label>
              <input name="default_card_limit" class="ltr" inputmode="numeric" value="${esc(settings.default_card_limit ?? '')}"></div>
            <button class="btn tonal">ذخیره</button>
          </form>
        </div>
      </div>
      <h2 style="margin-top:8px">کارت‌های شما</h2>
      ${cards.length ? `<div class="grid g2">${cards.map((c) => `
        <div class="card">
          ${bankCard(c.number, c.holder_name, { off: !c.active })}
          <div style="margin-top:14px">
            <div class="spread small"><span>دریافتی امروز + رزرو: ${toman(c.received_today + c.reserved)}</span>
              <span class="muted">سقف: ${toman(c.daily_limit)}${c.daily_limit_is_custom ? ' (اختصاصی)' : ''}</span></div>
            <div class="bar" style="margin:6px 0 12px"><i style="width:${Math.min(100, ((c.received_today + c.reserved) / c.daily_limit) * 100)}%"></i></div>
            <form data-form="cardAccount" data-id="${c.id}" class="row" style="margin-bottom:8px">
              <input name="account_number" class="ltr mono" inputmode="numeric" placeholder="شماره حساب (اختیاری)" value="${esc(c.account_number || '')}" style="flex:1;min-width:120px">
              <button class="btn ghost sm">ثبت حساب</button>
            </form>
            <form data-form="cardLimit" data-id="${c.id}" class="row">
              <input name="daily_limit" class="ltr" inputmode="numeric" placeholder="سقف اختصاصی (ریال)" value="${c.daily_limit_is_custom ? c.daily_limit : ''}" style="flex:1;min-width:120px">
              <button class="btn ghost sm">ثبت سقف</button>
              <button type="button" class="btn ghost sm" data-act="toggleCard" data-id="${c.id}" data-active="${c.active ? 0 : 1}">${c.active ? 'غیرفعال' : 'فعال'}</button>
              <button type="button" class="btn danger sm" data-act="deleteCard" data-id="${c.id}">حذف</button>
            </form>
          </div>
        </div>`).join('')}</div>` : `<div class="card empty">هنوز کارتی ثبت نشده است.</div>`}`;
  },

  async listen() {
    const [{ sources }, { devices }, { events }, { sender_banks: senderBanks }] = await Promise.all([
      api('GET', '/sources'), api('GET', '/devices'), api('GET', '/events'), api('GET', '/sender-banks'),
    ]);
    const bankOptions = (selected) => Object.entries(state.banks.banks).filter(([code]) => code !== 'unknown')
      .map(([code, b]) => `<option value="${esc(code)}" ${code === selected ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
    const base = state.me.base_url;
    const tok = state.flash.deviceToken;
    const pair = await ensurePair();
    return `${head('منابع شنود و دستگاه‌ها')}
      <div class="grid g2">
        <div class="card"><h2>منابع شنود</h2>
          <div class="note">پیامک و اعلان اپلیکیشن‌ها <b>هر دو به‌صورت پیش‌فرض فعال</b> هستند و نیازی به تنظیم ندارند.
            فقط پیام‌هایی که شبیه «واریز» بانکی باشند از گوشی ارسال می‌شوند و پیامک از شماره موبایل معمولی پذیرفته نمی‌شود.</div>
          <h3>محدود کردن فرستنده‌ها (اختیاری، امن‌تر)</h3>
          <p class="muted small">اگر برای پیامک یا اعلان فرستنده‌ای ثبت کنید، آن نوع فقط از همان فرستنده‌ها پذیرفته می‌شود.
            سرشماره را همان‌طور که در گوشی نمایش داده می‌شود وارد کنید.</p>
          <form data-form="addSource" class="row">
            <div class="field" style="flex:0 1 150px"><label>نوع</label>
              <select name="type"><option value="sms">پیامک</option><option value="notification">اعلان اپلیکیشن</option></select></div>
            <div class="field"><label>سرشماره پیامک / نام بسته اپ</label><input name="value" class="ltr" placeholder="Bank Mellat" required></div>
            <div class="field"><label>برچسب (اختیاری)</label><input name="label"></div>
            <button class="btn" >افزودن</button>
          </form>
          ${sources.length ? `<div class="tablewrap"><table><tr><th>نوع</th><th>مقدار</th><th>برچسب</th><th></th></tr>
            ${sources.map((s) => `<tr><td>${s.type === 'sms' ? 'پیامک' : 'اعلان'}</td>
              <td class="ltr mono">${esc(s.value)}</td><td>${esc(s.label || '')}</td>
              <td class="nowrap"><button class="btn ghost sm" data-act="toggleSource" data-id="${s.id}" data-enabled="${s.enabled ? 0 : 1}">${s.enabled ? 'فعال ✓' : 'غیرفعال'}</button>
              <button class="btn danger sm" data-act="deleteSource" data-id="${s.id}">حذف</button></td></tr>`).join('')}</table></div>`
            : `<div class="empty">محدودیتی ثبت نشده — همه فرستنده‌های بانکی پذیرفته می‌شوند.</div>`}
        </div>

        <div class="card"><h2>دستگاه‌های شنونده</h2>
          ${quickConnect(pair)}
          <div style="height:16px"></div>
          ${tok ? `<div class="note">توکن دستگاه — فقط همین یک‌بار نمایش داده می‌شود:</div>
            <div class="secret">${esc(tok)}</div>
            <div class="row" style="margin:8px 0 14px"><button class="btn ghost sm" data-act="copy" data-text="${esc(tok)}">کپی توکن</button>
            <button class="btn ghost sm" data-act="copy" data-text="${esc(base)}">کپی آدرس سرور</button></div>` : ''}
          ${devices.length ? `<div class="tablewrap"><table><tr><th>نام</th><th>نوع</th><th>توکن</th><th>آخرین اتصال</th><th></th></tr>
            ${devices.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.platform)}</td><td class="ltr mono">${esc(d.token_prefix)}…</td>
              <td>${date(d.last_seen_at)}</td><td><button class="btn danger sm" data-act="deleteDevice" data-id="${d.id}">حذف</button></td></tr>`).join('')}</table></div>`
            : `<div class="empty">دستگاهی متصل نیست.</div>`}
        </div>
      </div>

      <div class="grid g2">
        <div class="card"><h3>اندروید</h3>
          <p class="small">${state.me.apk_available
            ? `<a class="btn sm" href="/downloads/paychi-listener.apk">دانلود APK</a>`
            : `فایل APK هنوز ساخته نشده است؛ پروژه <code class="inline">android/</code> را با Android Studio بسازید و خروجی را در <code class="inline">public/downloads/paychi-listener.apk</code> قرار دهید.`}</p>
          <ol class="small"><li>اپ را نصب و باز کنید.</li>
            <li>در اپ «اسکن QR داشبورد» را بزنید و کد بالا را اسکن کنید؛ یا در اپ آدرس سرور <code class="inline">${esc(base)}</code>،
              شماره موبایل و رمز عبور حساب را وارد کنید.</li>
            <li>دسترسی «دریافت پیامک» و «دسترسی به اعلان‌ها» را بدهید.</li></ol>
        </div>
        <div class="card"><h3>iOS (شورتکات)</h3>
          <ol class="small"><li>Shortcuts ← Automation ← New ← <b>Message</b>؛ در «Message Contains» کلمه <b>واریز</b> را بگذارید و «Run Immediately» را انتخاب کنید.</li>
            <li>اکشن <b>Get Contents of URL</b> اضافه کنید: متد POST به آدرس زیر.</li>
            <li>هدر <code class="inline">Authorization: Bearer &lt;توکن دستگاه&gt;</code> — شورتکات نمی‌تواند وارد حساب شود، پس یک توکن بسازید:
              <button class="btn tonal sm" data-act="iosToken">ساخت توکن شورتکات</button></li>
            <li>بدنه JSON: <code class="inline">type=sms</code>، <code class="inline">sender=Sender</code>، <code class="inline">body=Content</code> (از Shortcut Input).</li></ol>
          <div class="secret">${esc(base)}/api/device/ingest</div>
        </div>
      </div>

      <div class="card"><h2>آخرین پیام‌های دریافتی</h2>
        <p class="muted small">بانک هر پیام از نام فرستنده یا متن (مثلاً «بانک ملت») و کارت از شماره کارت/حساب داخل متن شناسایی می‌شود.
          اگر پول به کارت یا بانک دیگری غیر از کارت تراکنش رسیده باشد، خودکار تأیید نمی‌شود؛ می‌توانید دستی تأیید کنید.</p>
        ${events.length ? `<div class="tablewrap"><table><tr><th>زمان</th><th>فرستنده</th><th>بانک / کارت</th><th>متن</th><th>مبلغ</th><th>نتیجه</th></tr>
          ${events.map((e) => `<tr><td class="nowrap">${date(e.received_at)}</td>
            <td><span class="ltr mono">${esc(e.sender)}</span><div class="small muted">${e.type === 'notification' ? 'اعلان' : 'پیامک'}</div></td>
            <td class="nowrap small">${e.bank_name ? esc(e.bank_name) : '<span class="muted">نامشخص</span>'}${e.card_last4 ? `<div class="ltr mono">•••• ${esc(e.card_last4)}</div>` : ''}</td>
            <td class="small" style="white-space:pre-wrap">${esc(e.body)}</td><td class="nowrap">${e.amount ? rial(e.amount) : '—'}</td>
            <td>${eventResult(e)}</td></tr>`).join('')}</table></div>`
          : `<div class="empty">هنوز پیامی دریافت نشده است.</div>`}
      </div>

      <div class="card"><h2>بانک فرستنده‌ها</h2>
        <p class="muted small">بانک هر سرشماره پیامک یا اپلیکیشن بانکی از اولین پیامش یاد گرفته می‌شود تا پیام‌های بعدی بدون نام بانک هم شناخته شوند.
          اگر اشتباه بود همین‌جا اصلاحش کنید. (برای اعلان‌ها، فرستنده همان نام بسته اپ است که در جدول بالا نمایش داده می‌شود.)</p>
        <form data-form="senderBank" class="row">
          <div class="field" style="flex:0 1 150px"><label>نوع</label>
            <select name="type"><option value="sms">پیامک</option><option value="notification">اعلان اپلیکیشن</option></select></div>
          <div class="field"><label>سرشماره پیامک / نام بسته اپ</label><input name="sender" class="ltr" placeholder="98200030" required></div>
          <div class="field"><label>بانک</label><select name="bank_code">${bankOptions('')}</select></div>
          <button class="btn">ذخیره</button>
        </form>
        ${senderBanks.length ? `<div class="tablewrap"><table><tr><th>نوع</th><th>فرستنده</th><th>بانک</th><th>منبع</th><th></th></tr>
          ${senderBanks.map((x) => `<tr><td>${x.type === 'sms' ? 'پیامک' : 'اعلان'}</td><td class="ltr mono">${esc(x.sender)}</td>
            <td>${esc(x.bank_name)}</td><td><span class="badge">${x.auto ? 'خودکار' : 'دستی'}</span></td>
            <td><button class="btn danger sm" data-act="deleteSenderBank" data-id="${x.id}">حذف</button></td></tr>`).join('')}</table></div>`
          : `<div class="empty">هنوز فرستنده‌ای شناسایی نشده است.</div>`}
      </div>`;
  },

  async merchants() {
    const { merchants } = await api('GET', '/merchants');
    const shown = merchants.filter((m) => m.active || state.showArchived);
    const archived = merchants.length - merchants.filter((m) => m.active).length;
    return `${head('فروشگاه‌ها')}
      <p class="muted small">هر فروشگاه (سایت، ربات، اپ) کلید API، وب‌هوک و تراکنش‌های جدا دارد.
        کارت‌ها و گوشی شنونده مشترک‌اند: یک گوشی واریزهای همه فروشگاه‌ها را تشخیص می‌دهد و مبلغ یکتا بین همه فروشگاه‌ها یکتاست.</p>
      <div class="card"><h2>فروشگاه جدید</h2>
        <form data-form="createMerchant" class="row">
          <div class="field"><label>نام</label><input name="name" required maxlength="80" placeholder="مثلاً فروشگاه آنلاین"></div>
          <div class="field"><label>آدرس سایت (اختیاری)</label><input name="website" class="ltr" placeholder="https://shop.example.ir"></div>
          <button class="btn">ساخت فروشگاه</button>
        </form>
      </div>
      <div class="grid g2">${shown.map((m) => `
        <div class="card">
          <div class="spread"><h2 style="margin:0">${esc(m.name)}</h2>${m.active ? '' : '<span class="badge cancelled">بایگانی</span>'}</div>
          ${m.website ? `<div class="small ltr muted">${esc(m.website)}</div>` : ''}
          <div class="row small" style="margin:10px 0;gap:14px">
            <span><b>${fa(m.stats.paid)}</b> موفق</span>
            <span><b>${fa(m.stats.pending)}</b> در انتظار</span>
            <span>دریافتی: <b>${toman(m.stats.paid_sum)}</b></span>
          </div>
          <div class="small">${m.api_key_prefix ? `کلید API: <code class="inline">${esc(m.api_key_prefix)}…</code>` : '<span class="muted">کلید API ساخته نشده</span>'}
            · ${m.webhook_url ? 'وب‌هوک ✓' : '<span class="muted">بدون وب‌هوک</span>'}
            · ${m.all_cards ? 'همه کارت‌ها' : `${fa(m.card_ids.length)} کارت`}</div>
          <a class="btn tonal sm" style="margin-top:12px" href="#merchant/${m.id}">مدیریت</a>
        </div>`).join('')}</div>
      ${archived ? `<button class="btn ghost sm" data-act="toggleArchived">${state.showArchived ? 'پنهان کردن' : 'نمایش'} ${fa(archived)} فروشگاه بایگانی‌شده</button>` : ''}`;
  },

  async merchant(id) {
    const [{ merchant: m }, { cards }, { transactions }, { deliveries }, { links }, tg] = await Promise.all([
      api('GET', '/merchants/' + id), api('GET', '/cards'),
      api('GET', `/transactions?merchant_id=${id}`), api('GET', `/webhooks?merchant_id=${id}`),
      api('GET', `/merchants/${id}/links`), api('GET', `/merchants/${id}/telegram`),
    ]);
    state.tgCount = tg.channels.length;
    const conn = state.tgConnect?.merchantId === m.id ? state.tgConnect : null;
    const { defaults, base_url: base } = state.me;
    const key = state.flash.apiKey?.merchantId === m.id ? state.flash.apiKey.key : null;
    const sel = new Set(m.card_ids);
    return `${head(m.name, `<a class="btn ghost sm" href="#merchants">همه فروشگاه‌ها</a>`)}
      ${m.active ? '' : `<div class="note warn">این فروشگاه بایگانی شده است؛ کلید API آن کار نمی‌کند.
        <button class="btn tonal sm" data-act="merchantActive" data-id="${m.id}" data-active="1">فعال‌سازی دوباره</button></div>`}
      <div class="grid g4" style="margin-bottom:16px">
        <div class="stat"><b>${fa(m.stats.paid)}</b><span>تراکنش موفق</span></div>
        <div class="stat"><b>${toman(m.stats.paid_sum)}</b><span>مجموع دریافتی</span></div>
        <div class="stat"><b>${fa(m.stats.pending)}</b><span>در انتظار پرداخت</span></div>
        <div class="stat"><b class="ltr">#${fa(m.id)}</b><span>شناسه فروشگاه</span></div>
      </div>
      <div class="grid g2">
        <div class="card"><h2>کلید API</h2>
          ${key ? `<div class="note">کلید جدید — فقط همین یک‌بار نمایش داده می‌شود:</div><div class="secret">${esc(key)}</div>
            <button class="btn ghost sm" style="margin:8px 0" data-act="copy" data-text="${esc(key)}">کپی</button>`
            : `<p class="small">${m.api_key_prefix ? `کلید فعلی: <code class="inline">${esc(m.api_key_prefix)}…</code>` : 'هنوز کلیدی ساخته نشده است.'}</p>`}
          <button class="btn" data-act="rotateKey" data-id="${m.id}" data-has="${m.api_key_prefix ? 1 : 0}">${m.api_key_prefix ? 'ساخت کلید جدید (کلید قبلی باطل می‌شود)' : 'ساخت کلید API'}</button>
<pre>import { Variz } from '@paychi/variz';
const variz = new Variz({ apiKey: process.env.VARIZ_API_KEY, baseUrl: '${esc(base)}' });
const tx = await variz.transactions.create({ amount: 1500000, order_id: 'INV-1' });</pre>
          <p class="small muted">نرم‌افزاری که برای واریزا نوشته شده (مثل ربات میرزا): آدرس API را
            <code class="inline">${esc(base)}/api/compat/variza/v1/pay</code> بگذارید، همین کلید را به‌جای توکن واریزا،
            و «فرمت وب‌هوک» را روی «سازگار با واریزا» قرار دهید.</p>
        </div>
        <div class="card"><h2>تنظیمات</h2>
          <form data-form="merchantSettings" data-id="${m.id}">
            <div class="field"><label>نام (در صفحه پرداخت نمایش داده می‌شود)</label><input name="name" required maxlength="80" value="${esc(m.name)}"></div>
            <div class="field"><label>آدرس سایت (اختیاری)</label><input name="website" class="ltr" value="${esc(m.website || '')}"></div>
            <div class="field"><label>آدرس وب‌هوک</label><input name="webhook_url" class="ltr" placeholder="https://example.com/webhooks/paychi" value="${esc(m.webhook_url || '')}"></div>
            <div class="field"><label>فرمت وب‌هوک</label><select name="webhook_format">
              <option value="paychi" ${m.webhook_format === 'variza' ? '' : 'selected'}>پی‌چی (پیش‌فرض)</option>
              <option value="variza" ${m.webhook_format === 'variza' ? 'selected' : ''}>سازگار با واریزا (ربات‌های میرزا و…)</option></select></div>
            <div class="field"><label>مهلت پرداخت هر تراکنش (ثانیه، ${fa(defaults.tx_min_ttl_sec)} تا ${fa(defaults.tx_max_ttl_sec)}) — خالی = ${fa(defaults.tx_ttl_sec)}</label>
              <input name="tx_ttl_sec" class="ltr" inputmode="numeric" value="${esc(m.tx_ttl_sec ?? '')}"></div>
            <button class="btn">ذخیره</button>
          </form>
          <label style="margin-top:14px">کلید امضای وب‌هوک</label>
          <div class="secret">${esc(m.webhook_secret)}</div>
          <div class="row" style="margin-top:8px"><button class="btn ghost sm" data-act="copy" data-text="${esc(m.webhook_secret)}">کپی</button>
            <button class="btn ghost sm" data-act="rotateSecret" data-id="${m.id}">تعویض کلید</button></div>
        </div>
      </div>
      <div class="grid g2">
        <div class="card"><h2>کارت‌های این فروشگاه</h2>
          ${cards.length ? `<form data-form="merchantCards" data-id="${m.id}">
            <label class="row" style="gap:8px;margin-bottom:6px"><input type="radio" name="mode" value="all" ${m.all_cards ? 'checked' : ''} style="width:auto">
              همه کارت‌ها (کارت‌های جدید هم خودکار اضافه می‌شوند)</label>
            <label class="row" style="gap:8px;margin-bottom:10px"><input type="radio" name="mode" value="some" ${m.all_cards ? '' : 'checked'} style="width:auto">
              فقط کارت‌های انتخاب‌شده:</label>
            ${cards.map((c) => `<label class="row small" style="gap:8px;margin:0 24px 6px 0">
              <input type="checkbox" name="card_${c.id}" ${sel.has(c.id) && !m.all_cards ? 'checked' : ''} style="width:auto">
              ${esc(c.bank_name)} <span class="ltr mono">•••• ${esc(last4(c.number))}</span> ${esc(c.holder_name || '')}
              ${c.active ? '' : '<span class="badge cancelled">غیرفعال</span>'}</label>`).join('')}
            <button class="btn tonal" style="margin-top:8px">ذخیره کارت‌ها</button>
          </form>` : `<div class="empty">ابتدا در تب <a href="#cards">کارت‌ها</a> کارت ثبت کنید.</div>`}
        </div>
        <div class="card"><h2>تراکنش آزمایشی</h2>
          <form data-form="testTx" class="row">
            <input type="hidden" name="merchant_id" value="${m.id}">
            <div class="field"><label>مبلغ (ریال)</label><input name="amount" class="ltr" inputmode="numeric" value="1500000" required></div>
            <button class="btn">ساخت تراکنش</button>
          </form>
          ${state.flash.tx?.merchant?.id === m.id ? `<div class="note">مبلغ یکتا: <b>${rial(state.flash.tx.amount)}</b> —
            <a href="${esc(state.flash.tx.payment_url)}" target="_blank" rel="noopener">باز کردن صفحه پرداخت</a></div>` : ''}
        </div>
      </div>
      <div class="card"><h2>لینک‌های پرداخت</h2>
        <p class="muted small">بدون برنامه‌نویسی: لینک را در اینستاگرام، تلگرام یا سایت بگذارید. خریدار لینک را باز می‌کند،
          (مبلغ را وارد می‌کند) و شماره کارت و مبلغ یکتا را می‌گیرد. پرداخت مثل بقیه تراکنش‌های این فروشگاه تأیید می‌شود.</p>
        <form data-form="createLink" data-id="${m.id}" class="row">
          <div class="field"><label>عنوان</label><input name="title" required maxlength="120" placeholder="مثلاً اشتراک یک‌ماهه"></div>
          <div class="field" style="flex:0 1 180px"><label>مبلغ (ریال) — خالی = خریدار وارد کند</label><input name="amount" class="ltr" inputmode="numeric"></div>
          <label class="row small" style="gap:6px;flex:0 1 auto"><input type="checkbox" name="ask_payer" style="width:auto"> نام و شماره خریدار را بپرس</label>
          <button class="btn">ساخت لینک</button>
        </form>
        ${links.length ? `<div class="grid g2" style="margin-top:12px">${links.map((l) => `
          <div class="card" style="margin:0;${l.active ? '' : 'opacity:.6'}">
            <div class="spread"><b>${esc(l.title)}</b>${l.active ? '' : '<span class="badge cancelled">غیرفعال</span>'}</div>
            <div class="small muted">${l.amount ? rial(l.amount) : 'مبلغ دلخواه خریدار'}${l.ask_payer ? ' — نام و شماره خریدار' : ''}
              — ${fa(l.paid)} پرداخت (${toman(l.paid_sum)})</div>
            <div class="qrbox" style="margin-top:8px"><div class="qr" style="width:110px">${l.qr_svg}</div>
              <div style="flex:1 1 160px">
                <div class="secret small">${esc(l.url)}</div>
                <div class="row" style="margin-top:8px">
                  <button class="btn ghost sm" data-act="copy" data-text="${esc(l.url)}">کپی لینک</button>
                  <a class="btn ghost sm" href="${esc(l.url)}" target="_blank" rel="noopener">باز کردن</a>
                  <button class="btn ghost sm" data-act="toggleLink" data-id="${l.id}" data-active="${l.active ? 0 : 1}">${l.active ? 'غیرفعال' : 'فعال'}</button>
                  <button class="btn danger sm" data-act="deleteLink" data-id="${l.id}">حذف</button>
                </div>
              </div>
            </div>
          </div>`).join('')}</div>` : ''}
      </div>

      <div class="card"><h2>اعلان پرداخت در تلگرام</h2>
        ${!tg.enabled ? `<div class="note">ربات تلگرام روی سرور تنظیم نشده است. در @BotFather یک ربات بسازید و توکن آن را
            در متغیر <code class="inline">TELEGRAM_BOT_TOKEN</code> سرور بگذارید (اگر سرور به تلگرام دسترسی ندارد،
            <code class="inline">TELEGRAM_API_BASE</code> را روی یک رله/پروکسی تنظیم کنید).</div>`
          : `<p class="muted small">هر پرداخت موفق این فروشگاه (و واریزی که برای تأیید دستی نگه داشته شده) به گفتگوی تلگرام شما پیام می‌شود.
              می‌توانید ربات را به یک گروه هم اضافه کنید.</p>
            ${conn ? `<div class="note">
                ${conn.link ? `<a class="btn" href="${esc(conn.link)}" target="_blank" rel="noopener">باز کردن تلگرام و زدن Start</a>` : ''}
                <p class="small" style="margin:10px 0 4px">یا این کد را برای ربات ${conn.bot ? `<b class="ltr">@${esc(conn.bot)}</b>` : ''} بفرستید:</p>
                <div class="secret">${esc(conn.code)}</div>
                <div class="small muted" style="margin-top:6px"><span class="pulse"></span>در انتظار اتصال… این صفحه خودش به‌روز می‌شود.</div>
              </div>`
              : `<button class="btn" data-act="tgConnect" data-id="${m.id}">اتصال تلگرام</button>`}
            ${tg.channels.length ? `<div class="tablewrap" style="margin-top:12px"><table><tr><th>گفتگو</th><th>وضعیت</th><th></th></tr>
              ${tg.channels.map((c) => `<tr><td>${esc(c.title || c.chat_id)}</td>
                <td class="small">${c.last_error ? `<span class="badge failed">خطا</span> <span class="muted ltr">${esc(c.last_error)}</span>` : '<span class="badge paid">فعال</span>'}</td>
                <td class="nowrap"><button class="btn ghost sm" data-act="tgTest" data-id="${c.id}">پیام آزمایشی</button>
                  <button class="btn danger sm" data-act="tgDelete" data-id="${c.id}">حذف</button></td></tr>`).join('')}</table></div>` : ''}`}
      </div>

      <div class="card"><h2>آخرین تراکنش‌ها</h2>
        ${transactions.length ? `<div class="tablewrap"><table><tr><th>شناسه</th><th>مبلغ</th><th>سفارش</th><th>کارت</th><th>وضعیت</th><th>ایجاد</th></tr>
          ${transactions.slice(0, 10).map((t) => `<tr><td class="ltr mono small"><a href="${esc(t.payment_url)}" target="_blank" rel="noopener">${esc(t.id)}</a></td>
            <td class="nowrap">${rial(t.amount)}</td><td class="small">${t.metadata?.payer_name
              ? `${esc(t.metadata.payer_name)}<div class="ltr muted">${esc(t.metadata.payer_phone || '')}</div>`
              : `<span class="ltr">${esc(t.order_id || (t.metadata?.payment_link ? 'لینک پرداخت' : '—'))}</span>`}</td>
            <td class="small">${esc(t.card.bank_name)} <span class="ltr mono">${esc(last4(t.card.number))}</span></td>
            <td>${badge(t.status)}</td><td class="nowrap small">${date(t.created_at)}</td></tr>`).join('')}</table></div>
          ${transactions.length > 10 ? `<a class="btn ghost sm" style="margin-top:8px" data-act="txOfMerchant" data-id="${m.id}">همه تراکنش‌ها</a>` : ''}`
          : `<div class="empty">تراکنشی وجود ندارد.</div>`}
      </div>
      <div class="card"><h2>آخرین ارسال‌های وب‌هوک</h2>${deliveriesTable(deliveries, { merchant: false })}</div>
      <div class="card"><h2>حذف یا بایگانی</h2>
        <p class="muted small">فروشگاهی که تراکنش دارد حذف نمی‌شود، فقط بایگانی می‌شود (کلید API آن باطل می‌شود و تاریخچه می‌ماند).</p>
        <div class="row">
          ${m.active ? `<button class="btn ghost sm" data-act="merchantActive" data-id="${m.id}" data-active="0">بایگانی</button>` : ''}
          <button class="btn danger sm" data-act="deleteMerchant" data-id="${m.id}">حذف فروشگاه</button>
        </div>
      </div>`;
  },

  async tx() {
    const f = state.txFilter;
    const qs = new URLSearchParams();
    if (f) qs.set('status', f);
    if (state.txMerchant) qs.set('merchant_id', state.txMerchant);
    const { transactions } = await api('GET', '/transactions?' + qs);
    const opt = (v, l) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`;
    return `${head('تراکنش‌ها', `<select data-change="txMerchant" style="width:auto">${merchantOptions(state.txMerchant, { all: true })}</select>
      <select data-change="txFilter" style="width:auto">${opt('', 'همه')}${opt('pending', 'در انتظار')}${opt('paid', 'پرداخت‌شده')}${opt('expired', 'منقضی')}${opt('cancelled', 'لغو شده')}</select>`)}
      <div class="card">${transactions.length ? `<div class="tablewrap"><table>
        <tr><th>شناسه</th><th>فروشگاه</th><th>مبلغ یکتا</th><th>مبلغ درخواستی</th><th>کارت</th><th>سفارش</th><th>وضعیت</th><th>ایجاد</th><th>انقضا</th></tr>
        ${transactions.map((t) => `<tr>
          <td class="ltr mono small"><a href="${esc(t.payment_url)}" target="_blank" rel="noopener">${esc(t.id)}</a></td>
          <td class="small">${t.merchant ? `<a href="#merchant/${t.merchant.id}">${esc(t.merchant.name)}</a>` : '—'}</td>
          <td class="nowrap"><b>${rial(t.amount)}</b></td><td class="nowrap muted">${rial(t.requested_amount)}</td>
          <td class="small">${esc(t.card.bank_name)}<br><span class="ltr mono">${esc(groupCard(t.card.number))}</span></td>
          <td class="ltr small">${esc(t.order_id || '—')}</td><td>${badge(t.status)}</td>
          <td class="nowrap small">${date(t.created_at)}</td><td class="nowrap small">${date(t.expires_at)}</td></tr>`).join('')}
        </table></div>` : `<div class="empty">تراکنشی وجود ندارد.</div>`}</div>`;
  },

  async dev() {
    const { base_url: base } = state.me;
    const { deliveries } = await api('GET', '/webhooks');
    return `${head('API و مستندات')}
      <div class="note">کلید API، وب‌هوک و مهلت پرداخت <b>برای هر فروشگاه جداست</b> — از تب <a href="#merchants">فروشگاه‌ها</a> تنظیم کنید.</div>

      <div class="card"><h2>توکن دستگاه (دستی)</h2>
        <p class="muted small">کاربران عادی در اپ با شماره موبایل و رمز وارد می‌شوند. اگر می‌خواهید شنونده خودتان را بنویسید
          (اسکریپت، شورتکات، اپ دیگر)، این‌جا توکن بسازید و با آن <code class="inline">POST /api/device/ingest</code> را صدا بزنید.</p>
        <form data-form="addDevice" class="row">
          <div class="field"><label>نام دستگاه</label><input name="name" placeholder="اسکریپت سرور"></div>
          <div class="field" style="flex:0 1 150px"><label>نوع</label>
            <select name="platform"><option value="other">سایر</option><option value="android">اندروید</option><option value="ios">iOS</option></select></div>
          <button class="btn">ساخت توکن</button>
        </form>
        ${state.flash.deviceToken ? `<div class="note">توکن دستگاه — فقط همین یک‌بار نمایش داده می‌شود:</div>
          <div class="secret">${esc(state.flash.deviceToken)}</div>
          <button class="btn ghost sm" style="margin-top:8px" data-act="copy" data-text="${esc(state.flash.deviceToken)}">کپی توکن</button>` : ''}
<pre>curl -X POST ${esc(base)}/api/device/ingest \\
  -H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" \\
  -d '{"type": "sms", "sender": "Bank Mellat", "body": "واریز 1,500,003"}'

# app sign-in (what the Android app does): returns a device token
curl -X POST ${esc(base)}/api/device/login -H "Content-Type: application/json" \\
  -d '{"phone": "09...", "password": "...", "device_name": "my phone", "install_id": "any-stable-id"}'</pre>
      </div>

      <div class="card"><h2>مستندات API</h2>
        <p class="small">همه مبالغ به <b>ریال</b> هستند. احراز هویت: <code class="inline">Authorization: Bearer pk_live_…</code></p>
        <h3>ساخت تراکنش</h3>
<pre>curl -X POST ${esc(base)}/api/v1/transactions \\
  -H "Authorization: Bearer $PAYCHI_KEY" -H "Content-Type: application/json" \\
  -d '{"amount": 1500000, "order_id": "INV-1001", "return_url": "https://shop.example/thanks"}'

# 201
{
  "id": "tx_k3m9...",            // unique id
  "status": "pending",
  "amount": 1500003,             // unique amount the payer must transfer exactly
  "requested_amount": 1500000,
  "card": { "number": "6104...", "bank": "mellat", "bank_name": "بانک ملت", "holder_name": "..." },
  "payment_url": "${esc(base)}/pay/tx_k3m9...",
  "expires_at": "2026-01-01T10:10:00.000Z"
}</pre>
        <p class="small">پارامترهای اختیاری: <code class="inline">callback_url</code> (وب‌هوک اختصاصی همین تراکنش)، <code class="inline">card_id</code>،
          <code class="inline">ttl</code> (ثانیه)، <code class="inline">description</code>، <code class="inline">metadata</code>.</p>
        <h3>سایر متدها</h3>
<pre>GET  /api/v1/transactions/:id          # status: pending | paid | expired | cancelled
GET  /api/v1/transactions?order_id=…   # list / search
POST /api/v1/transactions/:id/cancel
GET  /api/v1/cards                     # cards with daily limit and remaining capacity</pre>
        <h3>وب‌هوک</h3>
        <p class="small">رویدادها: <code class="inline">transaction.paid</code>، <code class="inline">transaction.expired</code>، <code class="inline">transaction.cancelled</code>.
          پاسخ 2xx یعنی دریافت شد؛ در غیر این صورت تا ۶ بار با فاصله افزایشی تکرار می‌شود. امضا را حتماً بررسی کنید:</p>
<pre>// header: X-Paychi-Signature: t=1700000000,v1=&lt;hex&gt;
const [, t, v1] = /t=(\\d+),v1=([0-9a-f]+)/.exec(req.headers['x-paychi-signature']);
const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(t + '.' + rawBody).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
  && Math.abs(Date.now() / 1000 - t) &lt; 300;</pre>
      </div>

      <div class="card"><h2>آخرین ارسال‌های وب‌هوک</h2>
        ${deliveriesTable(deliveries)}
      </div>`;
  },
};

// ------------------------------------------------------------------ actions
const reload = async () => {
  state.me = await api('GET', '/me');
  await show(state.tab);
};

const actions = {
  async logout() {
    await api('POST', '/logout', {});
    location.href = '/';
  },
  copy: (el) => copy(el.dataset.text),
  async subscribe(el) {
    await api('POST', '/subscribe', { plan_id: el.dataset.id });
    toast('پلن فعال شد');
    await reload();
  },
  async toggleCard(el) {
    await api('PATCH', '/cards/' + el.dataset.id, { active: el.dataset.active === '1' });
    await reload();
  },
  async deleteCard(el) {
    if (!confirm('این کارت حذف شود؟')) return;
    const r = await api('DELETE', '/cards/' + el.dataset.id);
    toast(r.deactivated ? 'کارت تراکنش دارد؛ فقط غیرفعال شد' : 'حذف شد');
    await reload();
  },
  async toggleSource(el) {
    await api('PATCH', '/sources/' + el.dataset.id, { enabled: el.dataset.enabled === '1' });
    await reload();
  },
  async deleteSource(el) {
    await api('DELETE', '/sources/' + el.dataset.id);
    await reload();
  },
  async deleteDevice(el) {
    if (!confirm('این دستگاه حذف شود؟ توکن آن باطل می‌شود.')) return;
    await api('DELETE', '/devices/' + el.dataset.id);
    await reload();
  },
  async confirmEvent(el) {
    if (!confirm('این پیام را برای تراکنش در انتظار با همین مبلغ تأیید می‌کنید؟ وب‌هوک «پرداخت شد» ارسال می‌شود.')) return;
    await api('POST', `/events/${el.dataset.id}/confirm`, {});
    toast('تراکنش تأیید شد');
    await reload();
  },
  async deleteSenderBank(el) {
    await api('DELETE', '/sender-banks/' + el.dataset.id);
    await reload();
  },
  async pairQr() {
    await ensurePair(true);
    await reload();
  },
  async iosToken() {
    state.flash.deviceToken = (await api('POST', '/devices', { name: 'iPhone Shortcut', platform: 'ios' })).token;
    await reload();
  },
  async rotateKey(el) {
    if (el.dataset.has === '1' && !confirm('کلید قبلی باطل می‌شود. ادامه می‌دهید؟')) return;
    const { api_key: key } = await api('POST', `/merchants/${el.dataset.id}/api-key`, {});
    state.flash.apiKey = { merchantId: Number(el.dataset.id), key };
    await reload();
  },
  async rotateSecret(el) {
    if (!confirm('کلید امضای وب‌هوک عوض شود؟ گیرنده وب‌هوک باید کلید جدید را بگیرد.')) return;
    await api('POST', `/merchants/${el.dataset.id}/webhook-secret`, {});
    await reload();
  },
  async toggleLink(el) {
    await api('PATCH', '/links/' + el.dataset.id, { active: el.dataset.active === '1' });
    await reload();
  },
  async deleteLink(el) {
    if (!confirm('این لینک حذف شود؟')) return;
    const r = await api('DELETE', '/links/' + el.dataset.id);
    toast(r.deactivated ? 'لینک پرداخت دارد؛ فقط غیرفعال شد' : 'لینک حذف شد');
    await reload();
  },
  async tgConnect(el) {
    const id = Number(el.dataset.id);
    const c = await api('POST', `/merchants/${id}/telegram/connect`, {});
    state.tgConnect = { merchantId: id, ...c };
    if (c.link) window.open(c.link, '_blank', 'noopener');
    await reload();
    // Watch for the chat to appear (the bot receives /start <code>).
    clearInterval(state.tgWatch);
    const before = state.tgCount;
    state.tgWatch = setInterval(async () => {
      if (state.tab !== 'merchant/' + id) return clearInterval(state.tgWatch);
      try {
        const { channels } = await api('GET', `/merchants/${id}/telegram`);
        if (channels.length > before) {
          clearInterval(state.tgWatch);
          state.tgConnect = null;
          toast('تلگرام وصل شد ✓');
          await reload();
        }
      } catch { /* keep watching */ }
    }, 3000);
  },
  async tgTest(el) {
    await api('POST', `/telegram/${el.dataset.id}/test`, {});
    toast('پیام آزمایشی ارسال شد');
  },
  async tgDelete(el) {
    if (!confirm('اعلان به این گفتگو قطع شود؟')) return;
    await api('DELETE', '/telegram/' + el.dataset.id);
    await reload();
  },
  async merchantActive(el) {
    await api('PATCH', '/merchants/' + el.dataset.id, { active: el.dataset.active === '1' });
    await reload();
  },
  async deleteMerchant(el) {
    if (!confirm('این فروشگاه حذف شود؟ کلید API آن باطل می‌شود.')) return;
    const r = await api('DELETE', '/merchants/' + el.dataset.id);
    toast(r.archived ? 'فروشگاه تراکنش دارد؛ بایگانی شد' : 'فروشگاه حذف شد');
    location.hash = 'merchants';
    state.me = await api('GET', '/me');
  },
  async toggleArchived() {
    state.showArchived = !state.showArchived;
    await show('merchants');
  },
  async txOfMerchant(el) {
    state.txMerchant = el.dataset.id;
    location.hash = 'tx';
  },
};

const forms = {
  async testTx(d) {
    state.flash.tx = await api('POST', '/transactions', { amount: numOrNull(d.amount), merchant_id: numOrNull(d.merchant_id) });
    await reload();
  },
  async createLink(d, form) {
    const { link } = await api('POST', `/merchants/${form.dataset.id}/links`, {
      title: d.title, amount: numOrNull(d.amount), ask_payer: d.ask_payer === 'on',
    });
    await copy(link.url);
    toast('لینک ساخته و کپی شد');
    await reload();
  },
  async createMerchant(d) {
    const { merchant } = await api('POST', '/merchants', { name: d.name, website: d.website.trim() || null });
    toast('فروشگاه ساخته شد');
    state.me = await api('GET', '/me');
    location.hash = 'merchant/' + merchant.id;
  },
  async merchantSettings(d, form) {
    await api('PATCH', '/merchants/' + form.dataset.id, {
      name: d.name, website: d.website.trim() || null,
      webhook_url: d.webhook_url.trim() || null, tx_ttl_sec: numOrNull(d.tx_ttl_sec),
      webhook_format: d.webhook_format,
    });
    toast('ذخیره شد');
    await reload();
  },
  async merchantCards(d, form) {
    const ids = Object.keys(d).filter((k) => k.startsWith('card_')).map((k) => Number(k.slice(5)));
    if (d.mode === 'some' && !ids.length) throw new Error('حداقل یک کارت انتخاب کنید');
    await api('PATCH', '/merchants/' + form.dataset.id, { all_cards: d.mode === 'all', card_ids: d.mode === 'all' ? [] : ids });
    toast('کارت‌های فروشگاه ذخیره شد');
    await reload();
  },
  async addCard(d) {
    await api('POST', '/cards', {
      number: digits(d.number), holder_name: d.holder_name,
      daily_limit: numOrNull(d.daily_limit), account_number: digits(d.account_number) || null,
    });
    toast('کارت ثبت شد');
    await reload();
  },
  async cardLimit(d, form) {
    await api('PATCH', '/cards/' + form.dataset.id, { daily_limit: numOrNull(d.daily_limit) });
    toast('سقف کارت ذخیره شد');
    await reload();
  },
  async cardAccount(d, form) {
    await api('PATCH', '/cards/' + form.dataset.id, { account_number: digits(d.account_number) || null });
    toast('شماره حساب ذخیره شد');
    await reload();
  },
  async senderBank(d) {
    await api('POST', '/sender-banks', d);
    toast('بانک فرستنده ذخیره شد');
    await reload();
  },
  async defaultLimit(d) {
    await api('PATCH', '/settings', { default_card_limit: numOrNull(d.default_card_limit) });
    toast('سقف پیش‌فرض ذخیره شد');
    await reload();
  },
  async addSource(d) {
    await api('POST', '/sources', d);
    await reload();
  },
  async addDevice(d) {
    state.flash.deviceToken = (await api('POST', '/devices', d)).token;
    await reload();
  },
};

const guard = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message, true);
  }
};

document.addEventListener('click', guard(async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return void (location.hash = tab.dataset.tab);
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) await actions[el.dataset.act](el);
}));

document.addEventListener('submit', guard(async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const btn = $('button:not([type=button])', form);
  if (btn) btn.disabled = true;
  try {
    await forms[form.dataset.form](Object.fromEntries(new FormData(form)), form);
  } finally {
    if (btn) btn.disabled = false;
  }
}));

document.addEventListener('change', guard(async (e) => {
  if (e.target.dataset.change === 'txFilter') {
    state.txFilter = e.target.value;
    await show('tx');
  }
  if (e.target.dataset.change === 'txMerchant') {
    state.txMerchant = e.target.value;
    await show('tx');
  }
}));

document.addEventListener('input', (e) => {
  const form = e.target.closest('[data-form="addCard"]');
  if (!form || !(e.target.matches('[data-cardinput]') || e.target.matches('[data-holderinput]'))) return;
  const numInput = $('[data-cardinput]', form);
  const n = digits(numInput.value).slice(0, 16);
  if (e.target === numInput) numInput.value = groupCard(n);
  $('#card-preview').innerHTML = bankCard(n, $('[data-holderinput]', form).value);
});

async function show(route) {
  // Routes: "tab" or "merchant/<id>".
  let [tab, arg] = String(route).split('/');
  if (!views[tab] || (tab === 'merchant' && !arg)) [tab, arg] = ['overview', undefined];
  route = arg ? `${tab}/${arg}` : tab;
  state.tab = route;
  const navTab = tab === 'merchant' ? 'merchants' : tab;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === navTab));
  const html = await views[tab](arg);
  if (state.tab !== route) return;
  main.innerHTML = html;
  if (tab !== 'overview' && tab !== 'merchant') delete state.flash.tx;
  if (tab !== 'listen' && tab !== 'dev') delete state.flash.deviceToken;
  watchForDevice((tab === 'overview' && state.me.counts.devices === 0) || tab === 'listen');
  if (tab !== 'merchant') delete state.flash.apiKey;
}

window.addEventListener('hashchange', guard(() => show(location.hash.slice(1))));

guard(async () => {
  [state.me, state.banks] = await Promise.all([api('GET', '/me'), api('GET', '/banks')]);
  $('#who').textContent = state.me.user.name || state.me.user.phone;
  // Internal mode: no subscriptions, so no plan tab.
  if (state.me.billing_mode === 'off') document.querySelectorAll('[data-tab="plan"]').forEach((b) => b.remove());
  await show(location.hash.slice(1) || 'overview');
})();
