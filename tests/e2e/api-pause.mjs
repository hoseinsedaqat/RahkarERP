/**
 * رفتارِ برنامه هنگامی که سرور در میانه‌ی کار نشست را نمی‌پذیرد (۴۰۱ِ پیاپی؛
 * مثلاً سرویس با کلیدِ تازه راه‌اندازی شده است).
 * انتظار:
 *  ۱) برنامه به «حالت محلی» نمی‌رود؛ کاربر به صفحه‌ی ورود برمی‌گردد
 *  ۲) درخواستِ بی‌حاصل تکرار نمی‌شود (کنسول پر از ۴۰۱ نمی‌شود)
 *  ۳) با ورودِ دوباره، اتصال و بارگذاریِ داده از سرور برقرار می‌شود
 */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` ${detail}` : ''}`);
};

const base = new URL('../../dist/', import.meta.url).pathname;
const html = readFileSync(`${base}index.html`, 'utf8')
  .replace(/<script type="module"[^>]*><\/script>/g, '')
  .replace(/<link rel="stylesheet"[^>]*>/g, '');
const asset = readFileSync(`${base}index.html`, 'utf8').match(/assets\/(index-[\w-]+\.js)/)[1];
const bundle = readFileSync(`${base}assets/${asset}`, 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost:8080/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom;
const doc = window.document;

// سروری که ورود را می‌پذیرد تا برنامه بالا بیاید، اما بعداً همه‌ی درخواست‌ها را ۴۰۱ می‌دهد
let calls = 0;
let rejectAll = false;
window.fetch = async (input, init) => {
  const path = String(input);
  calls += 1;
  if (rejectAll && !path.includes('/api/health') && !path.includes('/api/auth/login') && !path.includes('/api/auth/config')) {
    return new Response(JSON.stringify({ error: 'نشست معتبر نیست', code: 'AUTH_REQUIRED' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  return fetch(new URL(path, 'http://localhost:8080/'), init);
};
window.localStorage.clear();
const script = doc.createElement('script');
script.textContent = bundle;
doc.body.appendChild(script);
await wait(900);
doc.querySelector('#landing-login')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(400);
doc.querySelector('#username').value = 'admin';
doc.querySelector('#password').value = 'admin123';
doc.querySelector('#login-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(3000);
check('ورودِ نخست انجام می‌شود', /متصل/.test(doc.querySelector('#api-chip')?.textContent ?? ''), doc.querySelector('#api-chip')?.textContent?.trim());

// از این لحظه سرور همه‌چیز را ۴۰۱ می‌دهد
rejectAll = true;
doc.dispatchEvent(new window.Event('visibilitychange', { bubbles: true }));
await wait(3000);
check('کاربر به صفحه‌ی ورود برمی‌گردد (نه حالتِ محلی)', Boolean(doc.querySelector('#login-form')), doc.querySelector('#api-chip')?.textContent?.trim() ?? 'بدون نشانگر');
check('نشانه‌های نشستِ نامعتبر پاک شده‌اند', !window.localStorage.getItem('erp-token-v2'));

calls = 0;
for (let i = 0; i < 3; i += 1) {
  doc.dispatchEvent(new window.Event('visibilitychange', { bubbles: true }));
  await wait(1500);
}
check('پس از پایانِ نشست درخواستِ بی‌حاصل تکرار نمی‌شود', calls <= 6, `${calls} درخواست در ۴٫۵ ثانیه`);

// ورودِ دوباره: سرور دوباره سالم است
rejectAll = false;
doc.querySelector('#username').value = 'admin';
doc.querySelector('#password').value = 'admin123';
doc.querySelector('#login-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(4000);
check('با ورودِ دوباره اتصال برقرار می‌شود', /متصل/.test(doc.querySelector('#api-chip')?.textContent ?? ''), doc.querySelector('#api-chip')?.textContent?.trim());
check('برنامه در دسترس است (منوها پابرجا)', doc.querySelectorAll('[data-module]').length > 0, `${doc.querySelectorAll('[data-module]').length} ماژول`);

console.log(`\nنتیجه: ${failures ? `${failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(failures ? 1 : 0);
