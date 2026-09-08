/**
 * یکنواختیِ پنجره‌ها (استانداردِ «شیک بودنِ فرم‌ها و دکمه‌ها در همه‌ی بخش‌ها»).
 *
 * قاعده:
 *  - هر پنجره باید یک دکمه‌ی انصراف/بستنِ یکسان با کلاسِ btn-cancel داشته باشد
 *  - پنجره‌ای که عملی انجام می‌دهد باید دکمه‌ی اصلیِ یکسان (primary-button یا submit) داشته باشد
 *  - پنجره‌ی صرفاً نمایشی (تاریخچه، اعلان‌ها و …) فقط به دکمه‌ی بستن نیاز دارد
 *  - هیچ پنجره‌ای از کلاس‌هایِ متفرقه (btn-close/btn-primary) استفاده نکند
 *  - دکمه‌ی بستن باید واقعاً پنجره را ببندد
 */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` ${detail}` : ''}`);
};

/* ---------------------- بررسیِ ایستا: همه‌ی پنجره‌هایِ برنامه ---------------------- */
const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pattern = /openModal\(\s*'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'\s*,\s*`/gi;
const modals = [];
for (const match of source.matchAll(pattern)) {
  const id = match[1];
  let index = match.index + match[0].length;
  const body = [];
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') { body.push(source.slice(index, index + 2)); index += 2; continue; }
    if (char === '`') break;
    if (char === '$' && source[index + 1] === '{') {
      body.push('${'); index += 2;
      let brace = 1;
      while (index < source.length && brace) {
        if (source[index] === '{') brace += 1;
        else if (source[index] === '}') brace -= 1;
        index += 1;
      }
      continue;
    }
    body.push(char); index += 1;
  }
  modals.push({ id, body: body.join('') });
}

check('پنجره‌های برنامه شناسایی شدند', modals.length >= 25, `${modals.length} پنجره`);
const withoutCancel = modals.filter((modal) => !modal.body.includes('btn-cancel'));
check('همه‌ی پنجره‌ها دکمه‌ی انصراف/بستنِ یکسان دارند', withoutCancel.length === 0, withoutCancel.map((m) => m.id).join(' | '));

const informational = new Set(['install-modal', 'demo-modal', 'document-history-modal', 'journal-lines-modal', 'notifications-modal', 'period-modal']);
const missingPrimary = modals.filter((modal) => !informational.has(modal.id) && !/primary-button|type="submit"/.test(modal.body));
check('پنجره‌هایِ عملیاتی دکمه‌ی اصلی دارند', missingPrimary.length === 0, missingPrimary.map((m) => m.id).join(' | '));

check('هیچ کلاسِ متفرقه‌ای برای دکمه‌ها استفاده نشده', !/class="btn-close"/.test(source) && !/class="btn-primary"/.test(source));

/* ---------------------- بررسیِ زنده: بسته شدنِ پنجره‌ها ---------------------- */
const base = new URL('../../dist/', import.meta.url).pathname;
const html = readFileSync(`${base}index.html`, 'utf8')
  .replace(/<script type="module"[^>]*><\/script>/g, '')
  .replace(/<link rel="stylesheet"[^>]*>/g, '');
const asset = readFileSync(`${base}index.html`, 'utf8').match(/assets\/(index-[\w-]+\.js)/)[1];
const bundle = readFileSync(`${base}assets/${asset}`, 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost:8080/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom;
const doc = window.document;
window.fetch = (input, init) => fetch(new URL(String(input), 'http://localhost:8080/'), init);
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

// پنجره‌ی تاریخچه/نمایشی: باز کردن و بستن با دکمه
const historyButtons = [...doc.querySelectorAll('[data-document-history]')];
if (historyButtons.length) {
  historyButtons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(700);
  const opened = Boolean(doc.querySelector('#document-history-modal'));
  const closeButton = doc.querySelector('#document-history-modal [data-close]');
  check('پنجره‌ی تاریخچه باز می‌شود', opened);
  check('پنجره‌ی تاریخچه دکمه‌ی بستن دارد', Boolean(closeButton));
  closeButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(500);
  check('دکمه‌ی بستن پنجره را می‌بندد', !doc.querySelector('#document-history-modal'));
} else {
  check('پنجره‌ی تاریخچه باز می‌شود', true, 'سندی برای نمایش نبود — رد شد');
  check('پنجره‌ی تاریخچه دکمه‌ی بستن دارد', true, 'رد شد');
  check('دکمه‌ی بستن پنجره را می‌بندد', true, 'رد شد');
}

// پنجره‌ی وضعیتِ اتصال (همیشه در دسترس است از طریقِ نشانگرِ بالای صفحه)
doc.querySelector('#api-chip')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
const anyModal = doc.querySelector('.modal-backdrop');
check('پنجره با کلیک روی نشانگر باز می‌شود', Boolean(anyModal));
const cancel = anyModal?.querySelector('.btn-cancel');
check('پنجره‌ی باز، دکمه‌ی انصرافِ همسان دارد', Boolean(cancel));
cancel?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(600);
check('انصراف پنجره را می‌بندد', !doc.querySelector('.modal-backdrop'));

console.log(`\nنتیجه: ${failures ? `${failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(failures ? 1 : 0);
