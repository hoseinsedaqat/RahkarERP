/**
 * سناریوی واقعیِ شکایتِ کاربر: «بعد از ورود همه‌ی درخواست‌ها ۴۰۱ می‌گیرند و برنامه
 * به حالتِ محلی می‌رود».
 *
 * این تست بدترین حالت را می‌سنجد: کلیدِ امضای سرور عوض شده (یا پایگاه پاک شده)
 * و توکن‌های ذخیره‌شده در مرورگر دیگر معتبر نیستند. انتظارِ جدید:
 *  ۱) برنامه به «حالت محلی» نمی‌رود؛ صفحه‌ی ورود نشان داده می‌شود
 *  ۲) نشانه‌های نشستِ کهنه پاک می‌شوند تا طوفانِ ۴۰۱ تکرار نشود
 *  ۳) پس از ورودِ دوباره، نشست برقرار و داده‌ها از سرور بارگذاری می‌شوند
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
const calls = [];
window.fetch = async (input, init) => {
  const result = await fetch(new URL(String(input), 'http://localhost:8080/'), init);
  calls.push({ path: String(input), status: result.status });
  return result;
};

// کاربری که از قبل وارد بوده و توکن‌هایش حالا (بر اثر تغییرِ کلید یا پاک شدنِ پایگاه) نامعتبر است
window.localStorage.setItem('erp-session', JSON.stringify({ username: 'admin', name: 'کاربر', role: 'مدیر سیستم', organization: 'شرکت' }));
window.localStorage.setItem('erp-token-v2', 'old.old.old');
window.localStorage.setItem('erp-refresh-v1', 'old.old.old');

const script = doc.createElement('script');
script.textContent = bundle;
doc.body.appendChild(script);
await wait(5000);

const unauthorized = calls.filter((call) => call.status === 401).length;
check('صفحه‌ی ورود نشان داده می‌شود (نه حالتِ محلی)', Boolean(doc.querySelector('#login-form')));
check('کاربر با نشستِ نامعتبر داخلِ برنامه نمی‌ماند', !doc.querySelector('.app-shell'));
check('نشانه‌های نشستِ کهنه پاک شده‌اند', !window.localStorage.getItem('erp-token-v2') && !window.localStorage.getItem('erp-refresh-v1') && !window.localStorage.getItem('erp-session'));
check('طوفانِ ۴۰۱ رخ نمی‌دهد (فقط بررسیِ نشست و تازه‌سازی)', unauthorized <= 3, `${unauthorized} پاسخِ ۴۰۱`);
check('پیامِ راهنما نمایش داده می‌شود', /دوباره وارد شوید/.test(doc.querySelector('body > #toast')?.textContent ?? ''));

// ورودِ دوباره از همان صفحه
doc.querySelector('#username').value = 'admin';
doc.querySelector('#password').value = 'admin123';
calls.length = 0;
doc.querySelector('#login-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(5000);
const chip = doc.querySelector('#api-chip')?.textContent?.trim() ?? '';
check('پس از ورودِ دوباره، نشست برقرار می‌شود', /متصل/.test(chip), chip);
check('پس از ورود هیچ ۴۰۱ی رخ نمی‌دهد', calls.every((call) => call.status !== 401), `${calls.filter((call) => call.status === 401).length} مورد`);
check('فضای کاری از سرور بارگذاری می‌شود', calls.some((call) => /\/api\/workspace$/.test(call.path) && call.status === 200));
check('داده‌ها از سرور بارگذاری می‌شوند', (doc.querySelector('#app')?.textContent ?? '').trim().length > 200);

console.log(`\nنتیجه: ${failures ? `${failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(failures ? 1 : 0);
