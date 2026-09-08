/**
 * سناریوی end-to-end: داده‌ی واقعیِ سرور در رابط کاربری
 * این مجموعه داده‌ی مورد نیازش را خودش از طریق API می‌سازد، بنابراین به وضعیتِ
 * پایگاه داده‌ی محلی وابسته نیست و در هر محیطی (حتی CI) نتیجه‌ی یکسان می‌دهد.
 */
import { boot, wait, goModule, createChecker } from './harness.mjs';

const API = 'http://localhost:8080';
const { check, state } = createChecker();

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const tokens = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.token}` };
const call = (path, init = {}) => fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
/** برخی مسیرها آرایه را مستقیم و برخی درون { data } برمی‌گردانند */
const asList = (payload) => (Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []);

/* ------------------------------ آماده‌سازیِ داده ------------------------------ */
const existingEntries = await (await call('/api/accounting/entries')).json();
let entryNumbers = asList(existingEntries).map((entry) => entry.number);
if (entryNumbers.length < 3) {
  const drafts = [
    { sourceType: 'sales', amount: 1000000000, tax: 90000000, description: 'فروش محصول به شرکت صادراتی آریا', moduleId: 'sales' },
    { sourceType: 'purchase', amount: 640000000, tax: 57600000, description: 'خرید مواد اولیه از تأمین‌کننده فولاد', moduleId: 'purchasing' },
    { sourceType: 'payroll', amount: 304000000, description: 'حقوق و دستمزد مرداد ۱۴۰۵', moduleId: 'payroll' },
  ];
  for (const draft of drafts.slice(0, 3 - entryNumbers.length)) {
    const created = await call('/api/accounting/entries', { method: 'POST', body: JSON.stringify(draft) });
    const body = await created.json();
    const entry = body?.data ?? body; // پاسخِ ایجاد در برخی مسیرها مستقیم برمی‌گردد
    if (entry?.number) entryNumbers.push(entry.number);
  }
}

const existingChecks = await (await call('/api/treasury/checks')).json();
const checkParties = asList(existingChecks).map((row) => row.party);
if (!checkParties.includes('شرکت صادراتی آریا')) {
  await call('/api/treasury/checks', {
    method: 'POST',
    body: JSON.stringify({ number: '1001', serial: '۲۱/۱۴۰۵', bank: 'ملت', amount: 145000000, issueDate: '1405-05-15', dueDate: '1405-07-10', direction: 'دریافتنی', party: 'شرکت صادراتی آریا', description: 'بابت فروش عمده' }),
  });
}
if (!checkParties.includes('تأمین‌کننده فولاد')) {
  await call('/api/treasury/checks', {
    method: 'POST',
    body: JSON.stringify({ number: '2001', serial: '۳۳/۱۴۰۵', bank: 'صادرات', amount: 95000000, issueDate: '1405-05-10', dueDate: '1405-06-20', direction: 'پرداختنی', party: 'تأمین‌کننده فولاد', description: 'بابت خرید مواد' }),
  });
}

const existingPayroll = await (await call('/api/payroll/records')).json();
const payrollNames = asList(existingPayroll).map((row) => row.fullName);
if (!payrollNames.includes('علی رضایی')) {
  await call('/api/payroll/records', {
    method: 'POST',
    body: JSON.stringify({
      period: '1405-05',
      personnelCode: '1001',
      fullName: 'علی رضایی',
      payroll: { baseSalary: 180000000, benefits: 20000000, childrenCount: 1, seniorityYears: 5, overtimeHours: 20, overtimeRate: 150000, taxFreeBenefits: 5000000, workingDays: 30 },
    }),
  });
}

/* --------------------------- بررسیِ نمایش در رابط --------------------------- */
const { window, doc, errors } = await boot();
await wait(1200);

await goModule(doc, window, 'accounting');
const acc = doc.querySelector('#app')?.textContent ?? '';
check('اسناد حسابداری در رابط دیده می‌شود', entryNumbers.some((number) => acc.includes(String(number))), `شماره‌ها: ${entryNumbers.join(', ')}`);
check('صورت‌های مالی محاسبه شده', /ترازنامه/.test(acc));

await goModule(doc, window, 'treasury');
const tre = doc.querySelector('#app')?.textContent ?? '';
check('چک‌ها در خزانه‌داری دیده می‌شود', /شرکت صادراتی آریا|تأمین‌کننده فولاد/.test(tre));

await goModule(doc, window, 'payroll');
const pay = doc.querySelector('#app')?.textContent ?? '';
check('فیش حقوقی دیده می‌شود', /علی رضایی/.test(pay));

check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(state.failures ? `\nناموفق: ${state.failures}` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
