/**
 * سناریوی end-to-end: پایداریِ نشست و دارایی‌های رابط کاربری
 * ۱) کاربر وارد می‌شود، بین ماژول‌ها جابه‌جا می‌شود و نباید از برنامه بیرون بیفتد.
 * ۲) توکنِ صادرشده باید پس از راه‌اندازیِ دوباره‌ی سرویس هم معتبر بماند
 *    (کلید امضا در پوشه‌ی داده ذخیره می‌شود، نه در حافظه‌ی همان اجرا).
 * ۳) فونتِ فارسی باید به‌صورت داخلی (بدون اینترنت) بسته‌بندی شده باشد.
 * ۴) دکمه‌ی نمایشِ رمز عبور باید درونِ کادرِ ورودی و در مرکز عمودی قرار گیرد.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { boot, goModule, createChecker, wait } from './harness.mjs';

const base = new URL('../../', import.meta.url).pathname;
const health = async (port) => {
  try { const r = await fetch(`http://localhost:${port}/api/health`, { cache: 'no-store' }); return r.ok; } catch { return false; }
};

const { check, state } = createChecker();

async function run() {
  /* ------------------- ۱) نشستِ پایدار هنگام استفاده‌ی عادی ------------------- */
  const { window, doc } = await boot();
  let unauthorized = 0;
  const originalFetch = window.fetch;
  window.fetch = (input, init) => originalFetch(input, init).then((res) => {
    if (res.status === 401) unauthorized += 1;
    return res;
  });
  for (const id of ['overview', 'accounting', 'treasury', 'inventory']) {
    await goModule(doc, window, id);
  }
  await wait(2500);
  check('کاربر پس از جابه‌جایی بین ماژول‌ها داخل برنامه می‌ماند', Boolean(doc.querySelector('.app-shell')));
  check('هیچ درخواستِ ۴۰۱ (پایانِ نشست) رخ نداده است', unauthorized === 0, `تعداد: ${unauthorized}`);
  check('دکمه‌ی خروج در دسترس است', Boolean(doc.querySelector('#logout')));

  /* ------------- ۲) اعتبارِ توکن پس از راه‌اندازیِ دوباره‌ی سرویس ------------- */
  const port = 8099;
  const login = await fetch('http://localhost:8080/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const payload = await login.json();
  const child = spawn('node', ['--import', 'tsx', 'server/index.ts'], {
    cwd: base, env: { ...process.env, PORT: String(port), HOST: '0.0.0.0' }, stdio: 'ignore',
  });
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) { await wait(400); ready = await health(port); }
    check('نمونه‌ی دومِ سرویس برای آزمایش بالا آمد', ready);
    if (ready && payload?.token) {
      const me = await fetch(`http://localhost:${port}/api/me`, { headers: { Authorization: `Bearer ${payload.token}` } });
      check('توکن پس از راه‌اندازیِ دوباره همچنان معتبر است', me.ok, `وضعیت: ${me.status}`);
    }
  } finally {
    child.kill('SIGTERM');
  }

  /* ----------------------- ۳) فونتِ فارسیِ داخلی (بدون اینترنت) ----------------------- */
  const assetDir = `${base}/dist/assets`;
  const files = existsSync(assetDir) ? readdirSync(assetDir) : [];
  const fonts = files.filter((name) => name.startsWith('vazirmatn-') && name.endsWith('.woff2'));
  check('فایل‌های فونتِ وزیرمتن در خروجیِ ساخت وجود دارند', fonts.length >= 10, `تعداد: ${fonts.length}`);
  const cssFile = files.find((name) => name.endsWith('.css'));
  const css = cssFile ? readFileSync(`${assetDir}/${cssFile}`, 'utf8') : '';
  check('تعریفِ @font-face برای وزیرمتن در CSS خروجی هست', /@font-face\{[^}]*Vazirmatn/.test(css) || /font-family:Vazirmatn/.test(css));
  check('هیچ وابستگی به fonts.googleapis.com باقی نمانده است', !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(css));

  /* ------------------- ۴) جایگاهِ دکمه‌ی نمایشِ رمز عبور ------------------- */
  const source = readFileSync(`${base}/dist/assets/${files.find((n) => n.endsWith('.js')) ?? ''}`, 'utf8');
  check('دکمه‌ی نمایش رمز درونِ کادرِ ورودی (input-wrap) قرار دارد', /class="input-wrap"[\s\S]{0,400}id="toggle-password"/.test(source));
  const toggleRules = (css.match(/\.password-toggle\{[^}]*\}/g) ?? []).join('\n');
  check('دکمه‌ی نمایش رمز در مرکزِ عمودی است (top:50%)', /top:50%/.test(toggleRules));
  check('موقعیتِ اشتباهِ قدیمی (bottom:30px) حذف شده است', !/bottom:30px/.test(toggleRules));

  /* ---------- ۵) خروج با نقش‌های غیرمدیر نباید پنجره‌ای باز کند یا خودکار برگردد ---------- */
  console.log('خروج با نقش‌های مختلف');
  for (const [username, password] of [['hesabdari', '1234'], ['anbar', '1234'], ['foroosh', '1234']]) {
    const attempt = await boot({ username, password });
    await wait(2200);
    const loggedIn = Boolean(attempt.doc.querySelector('.app-shell'));
    check(`ورود با نقشِ ${username} انجام می‌شود`, loggedIn);
    if (!loggedIn) continue;
    attempt.doc.querySelector('#logout')?.dispatchEvent(new attempt.window.MouseEvent('click', { bubbles: true }));
    await wait(2200);
    const modalOpen = Boolean(attempt.doc.querySelector('.modal-backdrop'));
    const stillInside = Boolean(attempt.doc.querySelector('.app-shell'));
    const loginVisible = Boolean(attempt.doc.querySelector('#login-form') || attempt.doc.querySelector('#landing-login'));
    check(`${username}: پس از خروج هیچ پنجره‌ای باز نمی‌شود`, !modalOpen, modalOpen ? attempt.doc.querySelector('.modal-backdrop')?.id ?? '' : '');
    check(`${username}: پس از خروج داخلِ برنامه نمی‌ماند`, !stillInside);
    check(`${username}: صفحه‌ی ورود نمایش داده می‌شود`, loginVisible);
    // چند ثانیه صبر می‌کنیم: برنامه نباید خودکار برگردد
    await wait(3000);
    check(`${username}: پس از خروج خودکار وارد نمی‌شود`, !attempt.doc.querySelector('.app-shell'));
  }

  return state.failures;
}

await run();
console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
