import { boot, wait, goModule, createChecker } from './harness.mjs';
const { check, state } = createChecker();

const { window, doc, errors } = await boot();
await wait(2500);
await goModule(doc, window, 'organization');
await wait(1200);
const text = () => doc.querySelector('#app')?.textContent ?? '';

console.log('پنل تبادل داده');
check('پنل تبادل داده نمایش داده می‌شود', /تبادل داده با اکسل/.test(text()));
check('سه نوع داده ارائه می‌شود', doc.querySelectorAll('[data-import]').length === 3, `${doc.querySelectorAll('[data-import]').length} نوع`);
check('دکمه‌ی قالب برای هر نوع وجود دارد', doc.querySelectorAll('[data-template]').length === 3);

// ساخت فایل CSV شبیه‌سازی‌شده و ورود آن
console.log('ورودِ سرفصل‌های حسابداری از CSV');
const csv = '﻿کد حساب,عنوان حساب\n1101,صندوق فروشگاه\n1102,بانک ملی جاری\n1101,کد تکراری\n,بدون کد\n';
const rows = [];
(() => {
  // استفاده از توابع داخلیِ برنامه از طریق رابطِ فایل
  const input = doc.querySelector('#import-file');
  if (!input) return;
  const file = new window.File([csv], 'حساب‌ها.csv', { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dataset.kind = 'accounts';
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
})();
await wait(1800);
check('پنجره‌ی پیش‌نمایش باز می‌شود', Boolean(doc.querySelector('#import-modal')));
const previewText = doc.querySelector('#import-modal')?.textContent ?? '';
check('تعداد ردیف‌ها شمارش شده', /۴ ردیف/.test(previewText), (previewText.match(/\d+ ردیف[^\d]*/) ?? [''])[0].slice(0, 40));
check('ردیفِ معتبر شناسایی شده', /۳ ردیف معتبر/.test(previewText), (previewText.match(/S+ ردیف معتبر/) ?? [''])[0]);
check('خطای ردیف‌های ناقص نشان داده می‌شود', /خالی است/.test(previewText));

// تأیید ورود
doc.querySelector('#import-confirm')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1800);
check('پیامِ نتیجه نمایش داده می‌شود', /سرفصل/.test(doc.querySelector('body > #toast')?.textContent ?? ''), doc.querySelector('body > #toast')?.textContent?.slice(0, 40));
const accountKeys = Object.keys(window.localStorage).filter((key) => key.endsWith(':erp-accounts'));
const stored = accountKeys.map((key) => JSON.parse(window.localStorage.getItem(key) ?? '[]')).flat();
check('سرفصل‌ها در انبارِ شرکت ذخیره شده‌اند', stored.some((account) => account.code === '1101' && account.title === 'صندوق فروشگاه'), `${stored.length} سرفصل`);
check('کدِ تکراری دوباره وارد نشده', stored.filter((account) => account.code === '1101').length === 1);
check('ردیفِ بدون کد وارد نشده', !stored.some((account) => account.title === 'بدون کد'));

// خروجی گرفتن
console.log('خروجیِ CSV از داده‌ها');
doc.querySelector('[data-export-kind="accounts"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1500);
check('پیامِ خروجی نمایش داده می‌شود', /خروجی/.test(doc.querySelector('body > #toast')?.textContent ?? ''), doc.querySelector('body > #toast')?.textContent?.slice(0, 40));

check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
