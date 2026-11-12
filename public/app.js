// Dashboard SPA (no build step). All user-provided text goes through esc().
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const state = { me: null, banks: null, tab: 'overview', flash: {}, txFilter: '' };

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

// ------------------------------------------------------------------ views
const views = {
  async overview() {
    const { me } = state;
    const c = me.counts;
    const sub = me.subscription;
    const pair = c.devices === 0 ? await ensurePair() : null;
    const steps = [
      [!!sub, 'انتخاب پلن اشتراک', 'plan'],
      [c.cards > 0, 'ثبت شماره کارت', 'cards'],
      [c.devices > 0, 'اتصال گوشی (اندروید یا شورتکات iOS)', 'listen'],
      [!!me.settings.api_key_prefix, 'ساخت کلید API و تنظیم وب‌هوک', 'dev'],
    ];
    return `${head('نمای کلی')}
      <div class="grid g4" style="margin-bottom:16px">
        <div class="stat"><b>${fa(c.paid)}</b><span>تراکنش موفق</span></div>
        <div class="stat"><b>${toman(c.paid_sum)}</b><span>مجموع دریافتی</span></div>
        <div class="stat"><b>${fa(c.pending)}</b><span>در انتظار پرداخت</span></div>
        <div class="stat"><b>${sub ? esc(sub.plan.name) : '—'}</b><span>${sub ? `اعتبار تا ${date(sub.expires_at)}` : 'بدون اشتراک'}</span></div>
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
    const [{ sources }, { devices }, { events }] = await Promise.all([
      api('GET', '/sources'), api('GET', '/devices'), api('GET', '/events'),
    ]);
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
        ${events.length ? `<div class="tablewrap"><table><tr><th>زمان</th><th>فرستنده</th><th>متن</th><th>مبلغ</th><th>نتیجه</th></tr>
          ${events.map((e) => `<tr><td class="nowrap">${date(e.received_at)}</td><td class="ltr mono">${esc(e.sender)}</td>
            <td class="small" style="white-space:pre-wrap">${esc(e.body)}</td><td class="nowrap">${e.amount ? rial(e.amount) : '—'}</td>
            <td>${e.tx_id ? badge('paid') : e.is_deposit ? '<span class="badge">بدون تراکنش منطبق</span>' : '<span class="badge">واریز نیست</span>'}</td></tr>`).join('')}</table></div>`
          : `<div class="empty">هنوز پیامی دریافت نشده است.</div>`}
      </div>`;
  },

  async tx() {
    const f = state.txFilter;
    const { transactions } = await api('GET', '/transactions' + (f ? `?status=${f}` : ''));
    const opt = (v, l) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`;
    return `${head('تراکنش‌ها', `<select data-change="txFilter" style="width:auto">${opt('', 'همه')}${opt('pending', 'در انتظار')}${opt('paid', 'پرداخت‌شده')}${opt('expired', 'منقضی')}${opt('cancelled', 'لغو شده')}</select>`)}
      <div class="card">${transactions.length ? `<div class="tablewrap"><table>
        <tr><th>شناسه</th><th>مبلغ یکتا</th><th>مبلغ درخواستی</th><th>کارت</th><th>سفارش</th><th>وضعیت</th><th>ایجاد</th><th>انقضا</th></tr>
        ${transactions.map((t) => `<tr>
          <td class="ltr mono small"><a href="${esc(t.payment_url)}" target="_blank" rel="noopener">${esc(t.id)}</a></td>
          <td class="nowrap"><b>${rial(t.amount)}</b></td><td class="nowrap muted">${rial(t.requested_amount)}</td>
          <td class="small">${esc(t.card.bank_name)}<br><span class="ltr mono">${esc(groupCard(t.card.number))}</span></td>
          <td class="ltr small">${esc(t.order_id || '—')}</td><td>${badge(t.status)}</td>
          <td class="nowrap small">${date(t.created_at)}</td><td class="nowrap small">${date(t.expires_at)}</td></tr>`).join('')}
        </table></div>` : `<div class="empty">تراکنشی وجود ندارد.</div>`}</div>`;
  },

  async dev() {
    const { settings, defaults, base_url: base } = state.me;
    const { deliveries } = await api('GET', '/webhooks');
    const key = state.flash.apiKey;
    return `${head('API و وب‌هوک')}
      <div class="grid g2">
        <div class="card"><h2>کلید API</h2>
          ${key ? `<div class="note">کلید جدید — فقط همین یک‌بار نمایش داده می‌شود:</div><div class="secret">${esc(key)}</div>
            <button class="btn ghost sm" style="margin:8px 0" data-act="copy" data-text="${esc(key)}">کپی</button>`
            : `<p class="small">${settings.api_key_prefix ? `کلید فعلی: <code class="inline">${esc(settings.api_key_prefix)}…</code>` : 'هنوز کلیدی ساخته نشده است.'}</p>`}
          <button class="btn" data-act="rotateKey">${settings.api_key_prefix ? 'ساخت کلید جدید (کلید قبلی باطل می‌شود)' : 'ساخت کلید API'}</button>
        </div>
        <div class="card"><h2>وب‌هوک و تنظیمات تراکنش</h2>
          <form data-form="settings">
            <div class="field"><label>آدرس وب‌هوک</label><input name="webhook_url" class="ltr" placeholder="https://example.com/webhooks/paychi" value="${esc(settings.webhook_url || '')}"></div>
            <div class="field"><label>مهلت پرداخت هر تراکنش (ثانیه، ${fa(defaults.tx_min_ttl_sec)} تا ${fa(defaults.tx_max_ttl_sec)}) — خالی = ${fa(defaults.tx_ttl_sec)}</label>
              <input name="tx_ttl_sec" class="ltr" inputmode="numeric" value="${esc(settings.tx_ttl_sec ?? '')}"></div>
            <button class="btn">ذخیره</button>
          </form>
          <label style="margin-top:14px">کلید امضای وب‌هوک</label>
          <div class="secret">${esc(settings.webhook_secret)}</div>
          <div class="row" style="margin-top:8px"><button class="btn ghost sm" data-act="copy" data-text="${esc(settings.webhook_secret)}">کپی</button>
            <button class="btn ghost sm" data-act="rotateSecret">تعویض کلید</button></div>
        </div>
      </div>

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
        ${deliveries.length ? `<div class="tablewrap"><table><tr><th>زمان</th><th>رویداد</th><th>تراکنش</th><th>آدرس</th><th>تلاش</th><th>وضعیت</th></tr>
          ${deliveries.map((d) => `<tr><td class="nowrap small">${date(d.created_at)}</td><td class="ltr mono small">${esc(d.event)}</td>
            <td class="ltr mono small">${esc(d.tx_id)}</td><td class="ltr small">${esc(d.url)}</td><td>${fa(d.attempts)}</td>
            <td>${badge(d.status)} <span class="small muted ltr">${esc(d.last_error || d.last_code || '')}</span></td></tr>`).join('')}</table></div>`
          : `<div class="empty">هنوز وب‌هوکی ارسال نشده است.</div>`}
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
  async pairQr() {
    await ensurePair(true);
    await reload();
  },
  async iosToken() {
    state.flash.deviceToken = (await api('POST', '/devices', { name: 'iPhone Shortcut', platform: 'ios' })).token;
    await reload();
  },
  async rotateKey() {
    if (state.me.settings.api_key_prefix && !confirm('کلید قبلی باطل می‌شود. ادامه می‌دهید؟')) return;
    state.flash.apiKey = (await api('POST', '/api-key/rotate', {})).api_key;
    await reload();
  },
  async rotateSecret() {
    if (!confirm('کلید امضای وب‌هوک عوض شود؟')) return;
    await api('POST', '/webhook-secret/rotate', {});
    await reload();
  },
};

const forms = {
  async testTx(d) {
    state.flash.tx = await api('POST', '/transactions', { amount: numOrNull(d.amount) });
    await reload();
  },
  async addCard(d) {
    await api('POST', '/cards', { number: digits(d.number), holder_name: d.holder_name, daily_limit: numOrNull(d.daily_limit) });
    toast('کارت ثبت شد');
    await reload();
  },
  async cardLimit(d, form) {
    await api('PATCH', '/cards/' + form.dataset.id, { daily_limit: numOrNull(d.daily_limit) });
    toast('سقف کارت ذخیره شد');
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
  async settings(d) {
    await api('PATCH', '/settings', { webhook_url: d.webhook_url.trim() || null, tx_ttl_sec: numOrNull(d.tx_ttl_sec) });
    toast('ذخیره شد');
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
}));

document.addEventListener('input', (e) => {
  const form = e.target.closest('[data-form="addCard"]');
  if (!form || !(e.target.matches('[data-cardinput]') || e.target.matches('[data-holderinput]'))) return;
  const numInput = $('[data-cardinput]', form);
  const n = digits(numInput.value).slice(0, 16);
  if (e.target === numInput) numInput.value = groupCard(n);
  $('#card-preview').innerHTML = bankCard(n, $('[data-holderinput]', form).value);
});

async function show(tab) {
  if (!views[tab]) tab = 'overview';
  state.tab = tab;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const html = await views[tab]();
  if (state.tab !== tab) return;
  main.innerHTML = html;
  if (tab !== 'overview') delete state.flash.tx;
  if (tab !== 'listen' && tab !== 'dev') delete state.flash.deviceToken;
  watchForDevice((tab === 'overview' && state.me.counts.devices === 0) || tab === 'listen');
  if (tab !== 'dev') delete state.flash.apiKey;
}

window.addEventListener('hashchange', guard(() => show(location.hash.slice(1))));

guard(async () => {
  [state.me, state.banks] = await Promise.all([api('GET', '/me'), api('GET', '/banks')]);
  $('#who').textContent = state.me.user.name || state.me.user.phone;
  await show(location.hash.slice(1) || 'overview');
})();
