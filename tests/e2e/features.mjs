import { boot, wait, goModule, createChecker } from './harness.mjs';
const { check, state } = createChecker();

/* ===== قابلیت‌های جدید: یادآوریِ سررسید، سقف اعتبار، پشتیبان‌گیری ===== */
const { window, doc, errors } = await boot();
await wait(2500);

// یک چک با سررسیدِ نزدیک ثبت می‌کنیم تا یادآوری ساخته شود
console.log('یادآوریِ سررسید چک‌ها');
await goModule(doc, window, 'treasury');
await wait(1500);
doc.querySelector('#check-new')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(800);
const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const form = doc.querySelector('#check-form');
if (form) {
  for (const [name, value] of Object.entries({
    number: '77771', serial: 'ی/۱', bank: 'ملت', direction: 'پرداختنی',
    amount: '15000000', party: 'تأمین‌کننده یادآوری', issueDate: new Date().toISOString().slice(0, 10), dueDate: soon,
  })) { const field = form.querySelector(`[name="${name}"]`); if (field) field.value = value; }
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(1600);
}
await goModule(doc, window, 'treasury');
await wait(1600);
const treasuryText = doc.querySelector('#app')?.textContent ?? '';
check('پنلِ یادآوریِ سررسیدها نمایش داده می‌شود', /یادآوریِ سررسیدها/.test(treasuryText));
check('چکِ نزدیک‌سررسید در یادآوری دیده می‌شود', /تأمین‌کننده یادآوری/.test(treasuryText));
check('تعدادِ روزهای مانده محاسبه می‌شود', /روز مانده|امروز|روز گذشته/.test(treasuryText));

console.log('سقف اعتبار مشتریان');
await goModule(doc, window, 'sales');
await wait(1500);
check('پنلِ سقف اعتبار در فروش هست', Boolean(doc.querySelector('#credit-form')));
const creditForm = doc.querySelector('#credit-form');
if (creditForm) {
  creditForm.querySelector('[name="customer"]').value = 'شرکت آفتاب';
  creditForm.querySelector('[name="limit"]').value = '100000000';
  creditForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(1500);
}
const salesText = doc.querySelector('#app')?.textContent ?? '';
check('سقف اعتبار ثبت می‌شود', /سقف اعتبار «شرکت آفتاب»/.test(doc.querySelector('body > #toast')?.textContent ?? ''), (doc.querySelector('body > #toast')?.textContent ?? '').slice(0, 60));
check('درصدِ استفاده از سقف نمایش داده می‌شود', /٪ استفاده/.test(salesText));

// ثبت فاکتورِ بزرگ‌تر از سقف باید هشدار بدهد
doc.querySelector('#new-invoice')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(800);
const invoiceForm = doc.querySelector('#invoice-form');
if (invoiceForm) {
  for (const [name, value] of Object.entries({
    customerName: 'شرکت آفتاب', itemTitle: 'کالای آزمون', quantity: '10', unitPrice: '50000000', discount: '0', tax: '0',
  })) { const field = invoiceForm.querySelector(`[name="${name}"]`); if (field) field.value = value; }
  invoiceForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(1600);
}
check('عبور از سقف اعتبار هشدار می‌دهد', /سقف اعتبار/.test(doc.querySelector('body > #toast')?.textContent ?? ''), (doc.querySelector('body > #toast')?.textContent ?? '').slice(0, 70));

console.log('پشتیبان‌گیریِ خودکار');
await goModule(doc, window, 'organization');
await wait(1600);
check('بخشِ پشتیبان‌گیریِ خودکار دیده می‌شود', /پشتیبان‌گیریِ خودکار/.test(doc.querySelector('#app')?.textContent ?? ''));
doc.querySelector('#backup-now')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(2000);
const backupToast = doc.querySelector('body > #toast')?.textContent ?? '';
check('ساختِ نسخه‌ی پشتیبان روی سرور انجام می‌شود', /نسخه‌ی پشتیبان/.test(backupToast), backupToast.slice(0, 70));
check('فهرستِ نسخه‌ها نمایش داده می‌شود', doc.querySelectorAll('[data-backup-file]').length > 0, `${doc.querySelectorAll('[data-backup-file]').length} نسخه`);

console.log('اسنادِ تکرارشونده');
await goModule(doc, window, 'accounting');
await wait(2000);
const accountingText = doc.querySelector('#app')?.textContent ?? '';
check('پنلِ اسنادِ تکرارشونده در حسابداری هست', /اسنادِ تکرارشونده/.test(accountingText));
check('فرمِ تعریف الگو وجود دارد', Boolean(doc.querySelector('#recurring-form')));
const recurringForm = doc.querySelector('#recurring-form');
if (recurringForm) {
  for (const [name, value] of Object.entries({
    title: 'اجاره‌ی ماهانه دفتر', debitAccount: '6100', debitTitle: 'هزینه اجاره',
    creditAccount: '1100', creditTitle: 'بانک و صندوق', amount: '85000000', frequency: 'monthly',
  })) { const field = recurringForm.querySelector(`[name="${name}"]`); if (field) field.value = value; }
  recurringForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(1800);
}
check('الگوی تکرارشونده تعریف می‌شود', /تعریف شد/.test(doc.querySelector('body > #toast')?.textContent ?? ''), (doc.querySelector('body > #toast')?.textContent ?? '').slice(0, 60));
await wait(1200);
check('الگو در فهرست دیده می‌شود', /اجاره‌ی ماهانه دفتر/.test(doc.querySelector('#app')?.textContent ?? ''));
doc.querySelector('[data-recurring-run]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(2000);
const runToast = doc.querySelector('body > #toast')?.textContent ?? '';
check('سند از روی الگو صادر می‌شود', /سند شماره/.test(runToast), runToast.slice(0, 70));

console.log('صفِ سامانه‌ی مؤدیان');
await goModule(doc, window, 'sales');
await wait(2200);
const taxText = doc.querySelector('#app')?.textContent ?? '';
check('پنلِ صفِ مؤدیان در فروش هست', /صفِ سامانه‌ی مؤدیان/.test(taxText));
check('فاکتورِ ثبت‌شده در صف دیده می‌شود', doc.querySelectorAll('[data-tax-send]').length > 0 || /صورت‌حساب \d/.test(taxText),
  `${doc.querySelectorAll('[data-tax-send]').length} مورد در صف`);
doc.querySelector('[data-tax-send]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(2200);
const taxToast = doc.querySelector('body > #toast')?.textContent ?? '';
check('تلاشِ ارسال نتیجه‌ای روشن دارد', /مؤدیان|تنظیمات|ارسال/.test(taxToast), taxToast.slice(0, 70));
check('وضعیتِ صورت‌حساب در جدول ثبت می‌شود', /ارسال شد|ناموفق|در صف/.test(doc.querySelector('#app')?.textContent ?? ''));

check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\nنتیجه: ${state.failures ? `${state.failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(state.failures ? 1 : 0);
