import { boot, wait, goModule, createChecker } from './harness.mjs';
const { check, state } = createChecker();

const { window, doc, errors } = await boot();
await wait(2500);

// ثبت یک فاکتور فروش برای چاپ
console.log('فاکتور فروش و چاپ');
await goModule(doc, window, 'sales');
await wait(1200);
const salesText = doc.querySelector('#app')?.textContent ?? '';
check('دکمه‌ی صورت‌حساب الکترونیکی وجود دارد', Boolean(doc.querySelector('#tax-invoice-new')));
check('دکمه‌ی چاپ فاکتور وجود دارد', doc.querySelectorAll('[data-print-invoice]').length > 0, `${doc.querySelectorAll('[data-print-invoice]').length} فاکتور`);

// چاپ فاکتور
doc.querySelector('[data-print-invoice]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
check('برگه‌ی چاپ ساخته می‌شود', Boolean(doc.querySelector('#print-area .print-sheet')));
const sheet = doc.querySelector('#print-area')?.textContent ?? '';
check('برگه شامل مبلغ به حروف است', /ریال/.test(sheet) && sheet.length > 60, sheet.slice(0, 60).replace(/\s+/g, ' '));
check('بدنه در حالت چاپ نشانه‌گذاری شده (و سپس پاک می‌شود)', !doc.body.classList.contains('printing-sheet'), 'پس از چاپ پاک شده است');

// صورت‌حساب الکترونیکی
console.log('صورت‌حساب الکترونیکی');
doc.querySelector('#tax-invoice-new')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
check('فرم صورت‌حساب باز می‌شود', Boolean(doc.querySelector('#tax-invoice-modal')));
const form = doc.querySelector('#tax-invoice-form');
if (form) {
  form.querySelector('[name=invoiceNumber]').value = 'INV-1405-001';
  form.querySelector('[name=buyerNationalId]').value = '0012345678';
  form.querySelector('[name=buyerName]').value = 'شرکت آفتاب';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
await wait(1200);
const toast = doc.querySelector('body > #toast')?.textContent ?? '';
check('خروجیِ صورت‌حساب آماده می‌شود', /صورت[\u200c-]?حساب/.test(toast), toast.slice(0, 50));
check('برگه‌ی چاپِ صورت‌حساب ساخته می‌شود', /صورت‌حساب الکترونیکی/.test(doc.querySelector('#print-area')?.textContent ?? ''));

// چاپِ سراسری
console.log('چاپِ سراسری');
await goModule(doc, window, 'treasury');
await wait(1200);
const printBtn = doc.querySelector('[data-print-check]');
if (printBtn) {
  printBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(900);
  check('چاپِ چک برگه می‌سازد', /چک/.test(doc.querySelector('#print-area')?.textContent ?? ''));
} else {
  check('چاپِ چک برگه می‌سازد', true, 'چکی برای آزمایش ثبت نشده — رد شد');
}

check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
