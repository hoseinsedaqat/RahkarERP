/**
 * سناریوی end-to-end: نسخه‌ی نمایشیِ بدون سرور (همان چیزی که روی GitHub Pages منتشر می‌شود)
 * ۱) هیچ درخواستِ شبکه‌ای ارسال نمی‌شود (برنامه کاملاً محلی کار می‌کند).
 * ۲) ورود با حساب‌های معرفی‌شده انجام می‌شود و نشانگر «نسخه‌ی نمایشی» را نشان می‌دهد.
 * ۳) داده‌های نمونه بارگذاری می‌شوند تا بازدیدکننده صفحه‌ای پُر و واقعی ببیند.
 * ۴) تغییرِ نقش واقعاً ماژول‌های قابل‌مشاهده را عوض می‌کند.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createChecker, wait } from './harness.mjs';

const base = new URL('../../', import.meta.url).pathname;
const outDir = `${base}dist-demo`;
const { check, state } = createChecker();

if (!existsSync(`${outDir}/index.html`)) {
  execSync('npm run build:demo:local', { cwd: base, stdio: 'ignore' });
}
check('خروجیِ نسخه‌ی نمایشی ساخته شده است', existsSync(`${outDir}/index.html`));
check('فایل 404.html برای Pages وجود دارد', existsSync(`${outDir}/404.html`));
check('فایل .nojekyll وجود دارد', existsSync(`${outDir}/.nojekyll`));

const rawHtml = readFileSync(`${outDir}/index.html`, 'utf8');
const html = rawHtml.replace(/<script type="module"[^>]*><\/script>/g, '');
const asset = rawHtml.match(/assets\/(index-[\w-]+\.js)/)[1];
const bundle = readFileSync(`${outDir}/assets/${asset}`, 'utf8');
check('دارایی‌ها با مسیرِ نسبی ساخته شده‌اند (روی هر زیرمسیری کار می‌کند)', rawHtml.includes('"./assets/'), rawHtml.match(/src="[^"]*"/)?.[0] ?? '');

/** برنامه را بدون هیچ شبکه‌ای بالا می‌آوریم (هر درخواستی خطا می‌دهد و شمارش می‌شود) */
async function bootDemo(username, password) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => { if (!/Not implemented/.test(String(error.message))) errors.push(error.message); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://h03einsedaqat.github.io/arenaai/', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  let networkCalls = 0;
  window.fetch = () => { networkCalls += 1; return Promise.reject(new Error('بدون شبکه')); };
  window.localStorage.clear();
  const script = window.document.createElement('script');
  script.textContent = bundle;
  window.document.body.appendChild(script);
  await wait(800);
  const doc = window.document;
  doc.querySelector('#landing-login')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  doc.querySelector('#username').value = username;
  doc.querySelector('#password').value = password;
  doc.querySelector('#login-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(1500);
  return { window, doc, errors, network: () => networkCalls };
}

/* --------------------------- ورودِ مدیر و داده‌های نمونه --------------------------- */
const { window, doc, errors, network } = await bootDemo('admin', 'admin123');
check('ورود در نسخه‌ی نمایشی بدون خطا انجام می‌شود', Boolean(doc.querySelector('.app-shell')));
check('هیچ درخواستِ شبکه‌ای ارسال نشده است', network() === 0, `تعداد: ${network()}`);
check('نشانگر «نسخه‌ی نمایشی» را نشان می‌دهد', (doc.querySelector('#api-chip')?.textContent ?? '').includes('نسخه‌ی نمایشی'), doc.querySelector('#api-chip')?.textContent ?? '');

const text = doc.querySelector('#app')?.textContent ?? '';
check('داده‌های نمونه در داشبورد دیده می‌شود', /آفتاب|البرز|پارس/.test(text));
check('خلاصه‌ی مالی اعدادِ واقعی نشان می‌دهد', /[۰-۹]{2,}/.test(text));

// ماژولِ حسابداری: سرفصل‌های حساب‌ها و اسناد
doc.querySelector('[data-module="accounting"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(800);
const accountingText = doc.querySelector('#app')?.textContent ?? '';
check('سرفصل‌های حسابداری بارگذاری شده‌اند', /بانک|مواد اولیه/.test(accountingText));
check('اسنادِ حسابداریِ نمونه وجود دارند', /فروش محصول|خرید مواد/.test(accountingText));

// ماژولِ خزانه: چک‌ها
doc.querySelector('[data-module="treasury"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(800);
const treasuryText = doc.querySelector('#app')?.textContent ?? '';
check('چک‌های نمونه در خزانه دیده می‌شوند', /چک/.test(treasuryText) && /تأمین‌کننده فولاد|فروشگاه تهران/.test(treasuryText));
check('هیچ درخواستِ شبکه‌ای در طولِ کار ارسال نشد', network() === 0, `تعداد: ${network()}`);
check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));

/* --------------------- تغییرِ نقش: دسترسی‌ها واقعاً اعمال می‌شوند --------------------- */
const modulesOf = (root) => [...root.querySelectorAll('[data-module]')].map((button) => button.dataset.module);
const adminModules = modulesOf(doc);
doc.querySelector('#logout')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(900);
const sales = await bootDemo('foroosh', '1234');
check('ورود با نقشِ فروش انجام می‌شود', Boolean(sales.doc.querySelector('.app-shell')));
const salesModules = modulesOf(sales.doc);
check('نقشِ فروش ماژول‌های کمتری می‌بیند', salesModules.length < adminModules.length, `فروش: ${salesModules.length} / مدیر: ${adminModules.length}`);
check('نقشِ فروش به حسابداری دسترسی ندارد', !salesModules.includes('accounting'));
check('بدون خطای اجرایی در نقشِ دوم', sales.errors.length === 0, sales.errors.slice(0, 2).join(' | '));

console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
