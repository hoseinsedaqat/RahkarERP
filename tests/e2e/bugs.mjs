import { boot, wait, createChecker } from './harness.mjs';
const { check, state } = createChecker();

// شمارش درخواست‌ها
let healthCalls = 0;
let dataCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input);
  if (url.includes('/api/health')) healthCalls += 1;
  if (/\/api\/(accounting|documents|fiscal|cost|treasury|payroll|inventory|insights|budget)/.test(url)) dataCalls += 1;
  return originalFetch(input, init);
};

const { window, doc, errors } = await boot();
await wait(1500);
console.log('وضعیت پس از ورود');
check('نشست برقرار است', Boolean(doc.querySelector('#app .app-shell')));

// رفتن به ماژول حسابداری
doc.querySelector('[data-module="accounting"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1200);
const moduleNow = () => doc.querySelector('[data-module].active')?.textContent?.trim() ?? '';
check('ماژول حسابداری فعال شد', moduleNow().includes('مالی') || moduleNow().includes('حسابداری'), moduleNow());

// پنج ثانیه صبر: آیا ماژول عوض می‌شود؟
const before = { health: healthCalls, data: dataCalls };
await wait(5000);
check('ماژول در این مدت تغییر نکرد', (moduleNow().includes('مالی') || moduleNow().includes('حسابداری')), moduleNow());
console.log(`درخواست‌ها در ۵ ثانیه: سلامت=${healthCalls - before.health}، داده=${dataCalls - before.data}`);
check('درخواست‌های سلامت زیاد نیست (≤ ۳)', healthCalls - before.health <= 3, `${healthCalls - before.health} درخواست`);
check('درخواست‌های داده زیاد نیست (≤ ۲۰)', dataCalls - before.data <= 20, `${dataCalls - before.data} درخواست`);

// شبیه‌سازی حالت گوشی: بستن نوار کناری پس از انتخاب ماژول
console.log('حالت گوشی');
await wait(500);
const shell = doc.querySelector('.app-shell');
check('نوار کناری پس از انتخاب ماژول بسته می‌شود', !(shell?.classList.contains('sidebar-open')));

// آیا پس از خروج، دوباره وارد می‌شود؟
doc.querySelector('#logout')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1500);
const afterLogout = doc.querySelector('#app')?.textContent ?? '';
check('پس از خروج به صفحه‌ی آغازین می‌رویم', !doc.querySelector('.app-shell'), afterLogout.slice(0, 40));
const refreshLeft = window.localStorage.getItem('erp-refresh-v1');
check('توکن تازه‌سازی پس از خروج پاک شده', !refreshLeft, refreshLeft ? 'باقی مانده' : 'پاک شده');

check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
