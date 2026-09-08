import { boot, wait, goModule, createChecker } from './harness.mjs';
const { check, state } = createChecker();

/* ===================== ماژول گزارش‌گیری و هوش تجاری ===================== */
const { window, doc, errors } = await boot();
await wait(2500);

console.log('ماژول گزارش‌گیری');
await goModule(doc, window, 'reporting');
await wait(1800);

const text = doc.querySelector('#app')?.textContent ?? '';
check('عنوانِ ماژول دیده می‌شود', /تحلیل/.test(text));
check('پنج تبِ گزارش وجود دارد', doc.querySelectorAll('[data-reporting-tab]').length === 5, `${doc.querySelectorAll('[data-reporting-tab]').length} تب`);
check('کارت‌های شاخص کشیده می‌شوند', doc.querySelectorAll('.report-kpi').length >= 6, `${doc.querySelectorAll('.report-kpi').length} کارت`);
check('نمودارِ روند (SVG) ترسیم می‌شود', Boolean(doc.querySelector('.chart-svg path')));
check('نمودارِ دایره‌ای ترسیم می‌شود', Boolean(doc.querySelector('.donut-svg circle')));
check('رتبه‌بندیِ کالاها و مشتریان دیده می‌شود', doc.querySelectorAll('.rank-bars').length >= 1);

/* ---- تبِ تحلیل آماری ---- */
console.log('تحلیل آماری');
const tab = (key) => doc.querySelector(`[data-reporting-tab="${key}"]`);
tab('analytics')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1200);
const analytics = doc.querySelector('#app')?.textContent ?? '';
check('آمار توصیفی محاسبه می‌شود', /انحراف معیار/.test(analytics) && /ضریب تغییرات/.test(analytics));
check('جدولِ رشد ماهانه شش ماه را نشان می‌دهد', doc.querySelectorAll('.data-table tbody tr').length >= 6, `${doc.querySelectorAll('.data-table tbody tr').length} ردیف`);
check('همبستگی درآمد و هزینه گزارش می‌شود', /همبستگی/.test(analytics));

/* ---- تبِ نمودارها ---- */
console.log('نمودارها');
tab('charts')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1200);
check('نمودار ستونیِ گروهی ترسیم می‌شود', doc.querySelectorAll('.chart-svg rect').length >= 6, `${doc.querySelectorAll('.chart-svg rect').length} ستون`);
check('نمودارِ جریان نقد ترسیم می‌شود', doc.querySelectorAll('.chart-svg').length >= 2);

/* ---- تبِ کتابخانه ---- */
console.log('کتابخانه‌ی گزارش‌ها');
tab('library')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1200);
check('کارت‌های کتابخانه نمایش داده می‌شوند', doc.querySelectorAll('[data-library-report]').length >= 8, `${doc.querySelectorAll('[data-library-report]').length} گزارش`);
const before = doc.querySelector('.data-table')?.textContent ?? '';
doc.querySelector('[data-library-report="checks"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1200);
const after = doc.querySelector('.data-table')?.textContent ?? '';
check('انتخابِ گزارش، جدول را عوض می‌کند', before !== after);
check('جدولِ انتخاب‌شده ستونِ سررسید دارد', /سررسید/.test(after), after.slice(0, 40).replace(/\s+/g, ' '));

/* ---- تبِ گزارش‌ساز ---- */
console.log('گزارش‌ساز');
tab('builder')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(1500);
check('گزارش‌ساز در دسترس است', Boolean(doc.querySelector('.report-builder')));

check('هیچ خطای جاوااسکریپتی رخ نداده است', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\nنتیجه: ${state.failures ? `${state.failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(state.failures ? 1 : 0);
