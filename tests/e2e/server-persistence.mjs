/**
 * داده‌ها باید روی سرور بمانند، نه در مرورگر:
 *  ۱) رکوردی که در یک مرورگر ثبت می‌شود، بلافاصله به سرور فرستاده می‌شود (PUT /api/workspace)
 *  ۲) مرورگرِ دیگری با حافظه‌ی خالی همان رکورد را از سرور می‌بیند
 *  ۳) پاک شدنِ حافظه‌ی مرورگر هیچ داده‌ای را از بین نمی‌برد
 */
import { boot, wait, goModule, createChecker } from './harness.mjs';
const { check, state } = createChecker();

const stamp = String(Date.now()).slice(-6);
const customer = `مشتری پایدار ${stamp}`;

// مرورگر اول
const a = await boot();
const calls = [];
const original = a.window.fetch;
a.window.fetch = async (input, init) => {
  const result = await original(input, init);
  calls.push({ method: init?.method ?? 'GET', path: String(input), status: result.status });
  return result;
};
await wait(2500);
check('مرورگر اول به سرور متصل است', /متصل/.test(a.doc.querySelector('#api-chip')?.textContent ?? ''), a.doc.querySelector('#api-chip')?.textContent?.trim());

await goModule(a.doc, a.window, 'sales');
await wait(800);
a.doc.querySelector('#new-invoice')?.dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
await wait(500);
const form = a.doc.querySelector('#invoice-form');
check('فرمِ فاکتور باز می‌شود', Boolean(form));
if (form) {
  for (const [name, value] of Object.entries({ customerName: customer, itemTitle: 'کالای آزمون', quantity: '2', unitPrice: '1000000', discount: '0', tax: '0' })) {
    const field = form.querySelector(`[name="${name}"]`);
    if (field) field.value = value;
  }
  form.dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
}
await wait(2500);
const saved = calls.filter((call) => call.method === 'PUT' && /\/api\/workspace$/.test(call.path));
check('تغییر بلافاصله روی سرور ذخیره می‌شود (PUT /api/workspace)', saved.length > 0 && saved.every((call) => call.status === 200), `${saved.length} درخواست`);
check('فهرستِ پشتیبان‌ها بی‌دلیل بارگذاری نمی‌شود', calls.filter((call) => /backup\/list/.test(call.path)).length <= 1);

// مرورگر دوم با حافظه‌ی کاملاً خالی
const b = await boot();
await wait(3000);
await goModule(b.doc, b.window, 'sales');
await wait(800);
const text = b.doc.querySelector('#app')?.textContent ?? '';
check('مرورگرِ دیگر همان فاکتور را از سرور می‌بیند', text.includes(customer));
check('مرورگر دوم نیز متصل است', /متصل/.test(b.doc.querySelector('#api-chip')?.textContent ?? ''), b.doc.querySelector('#api-chip')?.textContent?.trim());

console.log(`\nنتیجه: ${state.failures ? `${state.failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(state.failures ? 1 : 0);
