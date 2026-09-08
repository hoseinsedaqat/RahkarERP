import { boot, wait, goModule, createChecker } from './harness.mjs';
const { check, state } = createChecker();

/* ===================== بررسیِ کاملِ همه‌ی فرم‌ها =====================
   هر فرم با داده‌ی معتبر پر و ثبت می‌شود؛ انتظار داریم هیچ پیامِ
   «نشست پایان یافته» یا خطایِ غیرمنتظره‌ای نمایش داده نشود.            */

const { window, doc, errors } = await boot();
await wait(2500);

// شناسه‌های یکتا تا اجرایِ دوباره‌ی تست با داده‌ی قبلی برخورد نکند
const uniq = String(Date.now()).slice(-6);

const toast = () => (doc.querySelector('body > #toast')?.textContent ?? '').trim();
const openModals = () => [...doc.querySelectorAll('.modal-backdrop')].map((item) => item.id);

/** پر کردن و ارسالِ یک فرمِ باز؛ نتیجه: پیام و وضعیتِ بسته شدنِ پنجره */
async function submitForm(formId, values) {
  const form = doc.querySelector(`#${formId}`);
  if (!form) return { ok: false, reason: `فرم ${formId} پیدا نشد` };
  for (const [name, value] of Object.entries(values)) {
    const field = form.querySelector(`[name="${name}"]`);
    if (field) field.value = value;
  }
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(1500);
  const message = toast();
  const closed = !doc.querySelector(`#${formId}`);
  return { ok: true, message, closed };
}

const bad = (message) => /نشست|باید وارد|دسترسی ندار/.test(message);

/* ---------- ۱) شرکت جدید از منوی بالا ---------- */
console.log('شرکت جدید');
doc.querySelector('#org-switcher')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1200);
const orgModal = doc.querySelector('#organization-modal');
check('پنجره‌ی شرکت‌ها باز می‌شود', Boolean(orgModal));
doc.querySelector('#organization-create')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1000);
let result = await submitForm('organization-create-form', {
  name: `شرکت آزمون ${uniq}`,
  code: `T${uniq.slice(0, 5)}`,
  nationalId: '10861814567',
  economicCode: '411522336699',
  address: 'تهران، خیابان آزادی',
  phone: '02188990011',
});
check('ایجاد شرکت انجام می‌شود', /ایجاد شد/.test(result.message), result.message || result.reason);
check('پنجره پس از ثبت شرکت بسته می‌شود', result.closed);
// پنجره‌ی راهنمای شروع (در صورت باز شدن) بسته می‌شود
doc.querySelectorAll('[data-close]').forEach((button) => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
await wait(500);

/* ---------- ۲) دوره‌ی مالی جدید ---------- */
console.log('دوره‌ی مالی');
await goModule(doc, window, 'organization');
await wait(1400);
let periodButton = doc.querySelector('#org-add-period');
if (!periodButton) periodButton = [...doc.querySelectorAll('button')].find((button) => /دوره‌ی مالی|دوره جدید/.test(button.textContent ?? ''));
periodButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1000);
const periodYear = 1409 + (Number(uniq.slice(-1)) % 5);
result = await submitForm('period-create-form', { year: String(periodYear), index: '1', title: `سال مالی ${periodYear}`, startsOn: `${periodYear}-01-01`, endsOn: `${periodYear}-12-29` });
check('ایجاد دوره‌ی مالی انجام می‌شود', /دوره|ایجاد/.test(result.message) && !bad(result.message), result.message || result.reason);
check('پنجره‌ی دوره بسته می‌شود', result.closed);

/* ---------- ۳) مرکز هزینه (و تستِ فوکوس) ---------- */
console.log('مرکز هزینه');
await goModule(doc, window, 'accounting');
await wait(1600);
const costForm = doc.querySelector('[data-cost-center-form]');
check('فرمِ مرکز هزینه در صفحه هست', Boolean(costForm));
if (costForm) {
  const codeInput = costForm.querySelector('[name="code"]');
  codeInput?.focus();
  await wait(120);
  // شبیه‌سازیِ تایپ: یک کاراکتر وارد و منتظرِ بازسازیِ احتمالی می‌مانیم
  if (codeInput) codeInput.value = 'C';
  codeInput?.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(700);
  check('فوکوس هنگامِ تایپ از دست نمی‌رود', doc.activeElement === doc.querySelector('[data-cost-center-form] [name="code"]'),
    `عنصرِ فعال: ${doc.activeElement?.tagName}[${(doc.activeElement?.getAttribute?.('name')) ?? ''}]`);
  const form = doc.querySelector('[data-cost-center-form]');
  if (form) {
    form.querySelector('[name="code"]').value = 'CC-9001';
    form.querySelector('[name="title"]').value = 'مرکز آزمون';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(1500);
  }
  check('مرکز هزینه ثبت می‌شود', !bad(toast()), toast() || '(بدون پیام)');
}

/* ---------- ۴) حساب جدید ---------- */
console.log('حساب جدید');
await goModule(doc, window, 'accounting');
await wait(1400);
doc.querySelector('#new-account')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('account-form', { code: '6300', title: 'هزینه‌ی آزمون' });
check('حساب جدید ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی حساب بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۵) ثبت تراکنش خزانه ---------- */
console.log('ثبت تراکنش خزانه');
await goModule(doc, window, 'treasury');
await wait(1500);
doc.querySelector('#new-treasury')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('treasury-form', {
  transactionType: 'receipt', accountTitle: 'دریافت آزمون', bankOrCash: 'بانک ملت',
  amount: '12500000', description: 'واریز تستی',
});
check('تراکنش خزانه ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی تراکنش بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۶) ثبت چک ---------- */
console.log('ثبت چک');
await goModule(doc, window, 'treasury');
await wait(1500);
doc.querySelector('#check-new')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
const today = new Date().toISOString().slice(0, 10);
result = await submitForm('check-form', {
  number: '99001', serial: 'الف/۹۹', bank: 'ملت', direction: 'دریافتنی',
  amount: '45000000', party: 'شرکت آزمون', issueDate: today, dueDate: '2026-12-29', description: 'چک تستی',
});
check('چک ثبت می‌شود', /چک ثبت شد/.test(result.message), result.message || result.reason);
check('پنجره‌ی چک بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۷) ردیف صورت‌حساب بانک ---------- */
console.log('ردیف صورت‌حساب بانک');
await goModule(doc, window, 'treasury');
await wait(1500);
doc.querySelector('#bank-statement')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('bank-form', {
  date: today, direction: 'دریافت', amount: '9800000', reference: 'TR-1', description: 'واریز نقدی تستی',
});
check('ردیف صورت‌حساب ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی صورت‌حساب بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۸) ورود و خروج انبار ---------- */
console.log('گردش انبار');
await goModule(doc, window, 'inventory');
await wait(1500);
doc.querySelector('#stock-movement')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('stock-form', {
  itemId: 'RM-TEST', itemTitle: 'ورق آزمون', type: 'ورود', quantity: '100', unitCost: '25000', method: 'wac', reference: 'رسید تستی',
});
check('ورود به انبار ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی انبار بسته می‌شود', result.closed, openModals().join(','));
// خروج با استفاده از موجودیِ تازه
doc.querySelector('#stock-movement')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('stock-form', {
  itemId: 'RM-TEST', itemTitle: 'ورق آزمون', type: 'خروج', quantity: '10', method: 'wac', reference: 'حواله تستی',
});
check('خروج از انبار ثبت می‌شود', !bad(result.message) && !/کافی نیست/.test(result.message), result.message || result.reason);

/* ---------- ۹) فیش حقوق ---------- */
console.log('فیش حقوق');
await goModule(doc, window, 'payroll');
await wait(1500);
doc.querySelector('#payroll-calc')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('payroll-form', {
  period: 'شهریور ۱۴۰۵', personnelCode: '9001', fullName: 'مریم آزمون',
  baseSalary: '120000000', childrenCount: '1', seniorityYears: '3', overtimeHours: '10',
  overtimeRate: '90000', benefits: '15000000', otherDeductions: '2000000',
});
check('فیش حقوق ثبت می‌شود', /ثبت و سند/.test(result.message), result.message || result.reason);
check('پنجره‌ی فیش بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۱۰) فاکتور فروش ---------- */
console.log('فاکتور فروش');
await goModule(doc, window, 'sales');
await wait(1500);
doc.querySelector('#new-invoice')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('invoice-form', {
  customerName: 'شرکت آزمون', itemTitle: 'خدمات تستی', quantity: '3', unitPrice: '4500000', discount: '0', tax: '10',
});
check('فاکتور فروش ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی فاکتور بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۱۱) سفارش خرید ---------- */
console.log('سفارش خرید');
await goModule(doc, window, 'purchasing');
await wait(1500);
doc.querySelector('#new-purchase')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('purchase-form', {
  supplierName: 'تأمین‌کننده آزمون', itemTitle: 'مواد اولیه', quantity: '20', unitPrice: '750000',
});
check('سفارش خرید ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی خرید بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۱۲) سفارش تولید ---------- */
console.log('سفارش تولید');
await goModule(doc, window, 'manufacturing');
await wait(1500);
const productionButton = [...doc.querySelectorAll('button')].find((button) => /سفارش تولید|تولید جدید/.test(button.textContent ?? ''));
productionButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('production-form', {
  productTitle: 'محصول آزمون', plannedQuantity: '50', materialTitle: 'ورق آزمون', materialQuantity: '40', unitCost: '25000', laborCost: '5000000',
});
check('سفارش تولید ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی تولید بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۱۳) ردیف بودجه ---------- */
console.log('ردیف بودجه');
await goModule(doc, window, 'budget');
await wait(1500);
doc.querySelector('#new-budget')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('budget-form', { title: 'بودجه‌ی آزمون', planned: '500000000', actual: '120000000' });
check('ردیف بودجه ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی بودجه بسته می‌شود', result.closed, openModals().join(','));

/* ---------- ۱۴) سرنخ و تیکت CRM ---------- */
console.log('CRM');
await goModule(doc, window, 'crm');
await wait(1500);
doc.querySelector('#new-lead')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('lead-form', { name: 'مشتری آزمون', stage: 'سرنخ جدید', value: '250000000', owner: 'سارا نادری' });
check('سرنخ ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی سرنخ بسته می‌شود', result.closed, openModals().join(','));
doc.querySelector('#new-ticket')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
result = await submitForm('ticket-form', { title: 'تیکت آزمون', priority: 'متوسط' });
check('تیکت ثبت می‌شود', !bad(result.message) && !/ناموفق/.test(result.message), result.message || result.reason);
check('پنجره‌ی تیکت بسته می‌شود', result.closed, openModals().join(','));

/* ---------- نتیجه ---------- */
// پنجره‌های باقیمانده (در صورت بروز خطا در یکی از فرم‌ها) بسته می‌شوند
doc.querySelectorAll('[data-close]').forEach((button) => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
await wait(500);
check('هیچ پنجره‌ای باز نمانده است', openModals().length === 0, openModals().join(','));
check('هیچ خطای اجرایی رخ نداده است', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\nنتیجه: ${state.failures ? `${state.failures} مورد ناموفق` : 'همه‌ی فرم‌ها بدون خطا ثبت شدند'}`);
process.exit(state.failures ? 1 : 0);
