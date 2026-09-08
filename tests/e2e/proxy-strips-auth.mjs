/**
 * شبیه‌سازیِ پروکسی/CDNای که هدرِ Authorization را حذف می‌کند
 * (همان چیزی که در پیش‌نمایش‌های ابری و برخی تونل‌ها رخ می‌دهد و باعث می‌شد کاربر
 * سه ثانیه بعد از ورود از داشبورد بیرون بیفتد).
 *  ۱) با وجودِ حذفِ Authorization، برنامه متصل می‌ماند و هیچ ۴۰۱ای نمی‌گیرد
 *  ۲) کاربر به صفحه‌ی ورود برنمی‌گردد
 *  ۳) داده روی سرور ذخیره می‌شود (PUT /api/workspace → 200)
 *  ۴) نشست ۳۰ روزه است (توکنِ تازه‌سازی)
 */
import { boot, wait, createChecker, goModule } from './harness.mjs';
const { check, state } = createChecker();

const a = await boot();
const original = a.window.fetch;
const calls = [];
a.window.fetch = async (input, init = {}) => {
  // پروکسیِ بدجنس: هدرِ Authorization را دور می‌ریزد
  const headers = { ...(init.headers ?? {}) };
  for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key];
  const result = await original(input, { ...init, headers });
  calls.push({ method: init.method ?? 'GET', path: String(input), status: result.status });
  return result;
};

// نشستِ فعلی را دور می‌ریزیم و از نو وارد می‌شویم تا همه‌ی درخواست‌ها از پروکسیِ شبیه‌سازی‌شده بگذرند
a.doc.querySelector('#logout')?.dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
await wait(500);
check('خروج انجام شد و صفحه‌ی ورود آمد', Boolean(a.doc.querySelector('#landing-login') || a.doc.querySelector('#login-form')));
calls.length = 0;
a.doc.querySelector('#landing-login')?.dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
await wait(150);
const u = a.doc.querySelector('#username'); const p = a.doc.querySelector('#password');
if (u) u.value = 'admin';
if (p) p.value = 'admin123';
a.doc.querySelector('#login-form')?.dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
await wait(4000);

const unauthorized = calls.filter((call) => call.status === 401);
check('هیچ درخواستی ۴۰۱ نمی‌گیرد (با وجودِ حذفِ Authorization)', unauthorized.length === 0, unauthorized.map((c) => c.path).slice(0, 5).join(', '));
check('برنامه پس از ورود روی داشبورد می‌ماند', !a.doc.querySelector('#login-form') && Boolean(a.doc.querySelector('[data-module]')));
check('نشانگرِ وضعیت «متصل» است', /متصل/.test(a.doc.querySelector('#api-chip')?.textContent ?? ''), a.doc.querySelector('#api-chip')?.textContent);
const authorizedOk = calls.filter((call) => /\/api\/(me|workspace|organizations)/.test(call.path) && call.status === 200);
check('مسیرهای نیازمندِ احراز هویت ۲۰۰ می‌گیرند', authorizedOk.length > 0, String(authorizedOk.length));

// ثبتِ یک رکورد → باید روی سرور ذخیره شود
const stamp = String(Date.now()).slice(-6);
await goModule(a.doc, a.window, 'sales');
await wait(800);
a.doc.querySelector('#new-invoice')?.dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
await wait(500);
const form = a.doc.querySelector('#invoice-form');
if (form) {
  for (const [name, value] of Object.entries({ customerName: `مشتری پروکسی ${stamp}`, itemTitle: 'کالای آزمون', quantity: '1', unitPrice: '500000', discount: '0', tax: '0' })) {
    const field = form.querySelector(`[name="${name}"]`);
    if (field) field.value = value;
  }
  form.dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
}
await wait(2500);
const saved = calls.filter((call) => call.method === 'PUT' && /\/api\/workspace$/.test(call.path));
check('داده روی سرور ذخیره می‌شود (PUT /api/workspace → 200)', saved.length > 0 && saved.every((call) => call.status === 200), JSON.stringify(saved.slice(-2)));
check('پس از ثبت هم به صفحه‌ی ورود برنمی‌گردد', !a.doc.querySelector('#login-form'));

// عمرِ نشست
const refreshToken = a.window.localStorage.getItem('erp-refresh-v1');
let days = 0;
if (refreshToken) {
  const payload = JSON.parse(Buffer.from(refreshToken.split('.')[1], 'base64url').toString('utf8'));
  days = (payload.exp * 1000 - Date.now()) / 86400000;
}
check('نشست ۳۰ روزه است', days > 29.5 && days <= 30.1, `${days.toFixed(2)} روز`);

console.log(state.failures === 0 ? 'نتیجه: همه‌ی بررسی‌ها موفق' : `نتیجه: ${state.failures} بررسی ناموفق`);
process.exit(state.failures === 0 ? 0 : 1);
