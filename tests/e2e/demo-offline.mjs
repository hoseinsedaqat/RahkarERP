/**
 * بررسیِ نسخه‌ی بدونِ سرور (منتشرشده روی GitHub Pages / نسخه‌ی نمایشی):
 *  - هیچ ماژولی نباید برنامه را هنگ کند یا قفل کند
 *  - نباید پیامِ «نشست پایان یافته» یا «باید وارد سیستم بشید» دیده شود
 * اجرا: node tests/e2e/demo-offline.mjs   (پیش‌نیاز: npm run build:demo:local)
 */
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const base = new URL('../../dist-demo/', import.meta.url).pathname;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` ${detail}` : ''}`);
};

if (!existsSync(`${base}index.html`)) {
  console.log('پوشه‌ی dist-demo ساخته نشده است؛ ابتدا npm run build:demo:local را اجرا کنید.');
  process.exit(1);
}

const html = readFileSync(`${base}index.html`, 'utf8')
  .replace(/<script type="module"[^>]*><\/script>/g, '')
  .replace(/<link rel="stylesheet"[^>]*>/g, '');
const asset = readFileSync(`${base}index.html`, 'utf8').match(/assets\/(index-[\w-]+\.js)/)[1];
const bundle = readFileSync(`${base}assets/${asset}`, 'utf8');
const virtualConsole = new VirtualConsole();
const errors = [];
virtualConsole.on('jsdomError', (error) => { if (!/Not implemented/.test(String(error.message))) errors.push(error.message); });
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost:8080/', pretendToBeVisual: true, virtualConsole });
const { window } = dom;
const doc = window.document;
window.fetch = () => Promise.reject(new Error('offline')); // نسخه‌ی بدون سرور: هیچ درخواستی به بیرون نمی‌رود
window.localStorage.clear();
const script = doc.createElement('script');
script.textContent = bundle;
doc.body.appendChild(script);
await wait(700);

doc.querySelector('#landing-login')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(300);
// ورودِ واقعی: دکمه‌ی «مدیر سیستم» در فهرستِ حساب‌های سریع
doc.querySelector('[data-quick-user="admin"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1600);
check('ورود به نسخه‌ی بدون سرور انجام می‌شود', doc.querySelectorAll('[data-module]').length > 0, `${doc.querySelectorAll('[data-module]').length} ماژول در منو`);

console.log('گشت‌وگذارِ همه‌ی ماژول‌ها (نسخه‌ی بدون سرور)');
const modules = [
  ['overview', 'نمای کلی'], ['identity', 'هویت و دسترسی'], ['organization', 'سازمان'], ['workflow', 'گردش کار'],
  ['integration', 'یکپارچه‌سازی'], ['accounting', 'مالی و حسابداری'], ['treasury', 'خزانه‌داری'], ['sales', 'فروش'],
  ['purchasing', 'خرید و تدارکات'], ['inventory', 'انبار'], ['payroll', 'حقوق و دستمزد'], ['hr', 'منابع انسانی'],
  ['fixed-assets', 'دارایی ثابت'], ['manufacturing', 'تولید'], ['budget', 'بودجه'], ['crm', 'CRM'], ['reporting', 'گزارش‌گیری'],
];
for (const [id, title] of modules) {
  const started = Date.now();
  doc.querySelector(`[data-module="${id}"]`)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(900);
  const elapsed = Date.now() - started;
  const text = doc.querySelector('#app')?.textContent ?? '';
  // اگر برنامه هنگ کند، هیچ رخدادِ دیگری اجرا نمی‌شود و این اندازه‌گیری بسیار بزرگ می‌شود
  check(`ماژولِ ${title} باز می‌شود و قفل نمی‌کند`, elapsed < 4000 && text.trim().length > 0, `${elapsed} میلی‌ثانیه`);
}

// فقط متنِ رابط کار بررسی می‌شود (نه کدِ برنامه که درونِ برچسبِ script است)
const uiText = `${doc.querySelector('#app')?.textContent ?? ''} ${doc.querySelector('body > #toast')?.textContent ?? ''} ${doc.querySelector('.login-error')?.textContent ?? ''}`;
check('هیچ پیامِ «نشست پایان یافته» در نسخه‌ی بدون سرور نیست', !/پایان یافته|باید وارد سیستم/.test(uiText));
check('هیچ خطای اجرایی رخ نداده است', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\nنتیجه: ${failures ? `${failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(failures ? 1 : 0);
