/**
 * سناریوی end-to-end: پایداریِ رابط کاربری هنگام کار
 * ۱) نشانگرِ وضعیتِ اتصال نباید مدام بین «در حال بررسی اتصال» و «متصل به سرور» بپرد؛
 *    پیش از این متنِ نشانگر در قالبِ HTML ثابت بود و با هر بازسازیِ صفحه عوض می‌شد.
 * ۲) ثبتِ رویداد (و هر فرم دیگر) باید کامل انجام شود: باز شدنِ پنجره، ثبت، پیام و نمایش در جدول.
 * ۳) پنجره‌های بازشو بیرون از #app ساخته می‌شوند تا هیچ بازسازی آن‌ها را نبندد.
 */
import { createChecker, boot, wait } from './harness.mjs';

const { check, state } = createChecker();

const { window, doc, errors } = await boot();

const chipText = () => doc.querySelector('#api-chip')?.textContent?.trim() ?? '';
check('نشانگر پس از ورود وضعیتِ واقعی را نشان می‌دهد', chipText().includes('متصل'), chipText());
check('نشانگر روی «در حال بررسی اتصال» گیر نکرده است', !chipText().includes('در حال بررسی'), chipText());

// پایشِ پیوسته‌ی متنِ نشانگر هنگام کار
let chipChanges = 0;
const samples = [];
let previous = chipText();
let watching = true;
const watch = () => {
  if (!watching) return;
  const now = doc.querySelector('#api-chip')?.textContent?.trim() ?? '';
  if (now !== previous) { chipChanges += 1; samples.push(`${previous} → ${now}`); previous = now; }
  setTimeout(watch, 60);
};
watch();

// کارِ عادیِ کاربر: جابه‌جایی بین ماژول‌ها و تایپ در جست‌وجو (هر کدام بازسازیِ صفحه‌اند)
for (const id of ['accounting', 'treasury', 'inventory', 'sales']) {
  doc.querySelector(`[data-module="${id}"]`)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(700);
  const search = doc.querySelector('#search-input');
  if (search) {
    search.value = 'گردش';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(350);
  }
}
// کمی صبر تا بررسیِ دوره‌ایِ وضعیت هم رخ بدهد
await wait(6000);
watching = false;

check('نشانگرِ اتصال هنگام کار هیچ تغییری نکرده است', chipChanges === 0, `${chipChanges} تغییر ${samples.join(' | ')}`);
check('نشانگر همچنان «متصل به سرور» است', chipText().includes('متصل'), chipText());

/* ------------------------------ ثبتِ رویدادِ جدید ------------------------------ */
doc.querySelector('#search-input')?.setAttribute('value', '');
doc.querySelector('#new-entry')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(500);
const modal = doc.querySelector('#record-form');
check('پنجره‌ی ثبت رویداد باز می‌شود', Boolean(modal));
check('پنجره بیرون از #app ساخته شده تا با بازسازیِ صفحه نپرد', modal?.closest('#app') === null);

if (modal) {
  const title = modal.querySelector('[name=title]');
  const amount = modal.querySelector('[name=amount]');
  if (title) title.value = 'رویداد پایداری';
  if (amount) amount.value = '۱۲۳۴۵۶۷';
  modal.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(1200);
  check('پس از ثبت، پنجره بسته می‌شود', !doc.querySelector('#record-form'));
  const toast = doc.querySelector('.toast')?.textContent?.trim() ?? '';
  check('پیامِ موفقیت نمایش داده می‌شود', toast.includes('ثبت شد'), toast);
  check('رویداد در جدول دیده می‌شود', (doc.querySelector('#app')?.textContent ?? '').includes('رویداد پایداری'));
}

check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
