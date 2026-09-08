/**
 * جلوگیری از چرخه‌ی «متصل به سرور ⇄ عدم اتصال».
 *
 * سناریو: کاربر وارد شده و نشست کاملاً سالم است، اما یکی از بخش‌های داده
 * (مثلاً به‌دلیلِ دسترسی) مدام پاسخِ ۴۰۱ می‌دهد. انتظار:
 *  - وضعیتِ اتصال روی «متصل به سرور» بماند (نوسان نداشته باشد)
 *  - پنجره‌ی «اتصالِ دوباره» باز نشود
 *  - پیامِ مربوط به پایانِ نشست نمایش داده نشود
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
let unauthorizedFromBrokenSection = 0;
window.fetch = async (input, init) => {
  const path = String(input);
  // یک بخش به‌طور مصنوعی همیشه ۴۰۱ می‌دهد
  if (path.includes('/api/insights/summary')) {
    unauthorizedFromBrokenSection += 1;
    return new Response(JSON.stringify({ ok: false, error: 'دسترسی ندارید' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
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

check('ورود انجام شده و متصل است', /متصل/.test(doc.querySelector('#api-chip')?.textContent ?? ''), doc.querySelector('#api-chip')?.textContent?.trim());

// چند دورِ پایش (هر دور ۴۵ ثانیه است؛ این‌جا فشرده‌تر رخ می‌دهد)
const states = [];
for (let i = 0; i < 6; i += 1) {
  await wait(8000);
  states.push(doc.querySelector('#api-chip')?.textContent?.trim() ?? '');
}
const disconnected = states.filter((state) => !/متصل/.test(state));
check('بخشِ دارای خطا واقعاً درخواست داده است', unauthorizedFromBrokenSection > 0, `${unauthorizedFromBrokenSection} بار ۴۰۱`);
check('وضعیت در تمامِ مدت «متصل به سرور» می‌ماند', disconnected.length === 0, disconnected.join(' | '));
check('پنجره‌ی «اتصالِ دوباره» باز نمی‌شود', !doc.querySelector('#server-login-modal'));
check('هیچ پیامِ پایانِ نشست نمایش داده نمی‌شود', !/پایان یافته/.test(doc.querySelector('body > #toast')?.textContent ?? ''));

console.log(`\nنتیجه: ${failures ? `${failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(failures ? 1 : 0);
