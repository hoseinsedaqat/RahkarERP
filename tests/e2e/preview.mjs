import { boot, wait, goModule, createChecker } from './harness.mjs';
const { check, state } = createChecker();

const { window, doc, errors } = await boot();
await wait(1000);

console.log('نوار کناری و چندشرکتی');
check('انتخاب‌گر شرکت نمایش داده می‌شود', Boolean(doc.querySelector('#org-switcher')));
check('نام شرکت فعال درست است', (doc.querySelector('#org-switcher-name')?.textContent ?? '').includes('آریا'), doc.querySelector('#org-switcher-name')?.textContent);

console.log('ماژول سازمان (شرکت‌ها، دوره‌ها، پشتیبان)');
await goModule(doc, window, 'organization');
const orgText = doc.querySelector('#app')?.textContent ?? '';
check('پنل شرکت‌ها با داده‌ی واقعی نمایش داده می‌شود', /شرکت‌ها و واحدها/.test(orgText) && /گروه صنعتی آریا/.test(orgText));
check('پنل پشتیبان‌گیری برای مدیر نمایش داده می‌شود', /پشتیبان‌گیری و بازگردانی/.test(orgText));
check('دوره‌های مالی واقعی نمایش داده می‌شود', /فروردین ۱۴۰۵|دوره‌های مالی/.test(orgText));
check('دکمه‌ی مدیریت شرکت‌ها وجود دارد', Boolean(doc.querySelector('#org-manage')));

console.log('ماژول حسابداری');
await goModule(doc, window, 'accounting');
const accText = doc.querySelector('#app')?.textContent ?? '';
check('پنل سال مالی و مراکز هزینه بارگذاری شده', /سال مالی و مراکز هزینه/.test(accText));
check('مراکز هزینه نمایش داده می‌شود', /تولید|فروش و بازاریابی/.test(accText));
check('صورت‌های مالی نمایش داده می‌شود', /صورت‌های مالی و مالیات/.test(accText));

console.log('انتخاب‌گر شرکت باز می‌شود');
doc.querySelector('#org-switcher')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(600);
check('پنجره‌ی شرکت‌ها باز می‌شود', Boolean(doc.querySelector('#organization-modal')));
check('شرکت پیش‌فرض در فهرست است', doc.querySelectorAll('[data-organization]').length >= 1, `${doc.querySelectorAll('[data-organization]').length} شرکت`);

check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
