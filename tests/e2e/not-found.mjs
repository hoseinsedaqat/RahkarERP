/**
 * سناریوی end-to-end: صفحه‌ی «پیدا نشد» (۴۰۴)
 * ۱) نشانی‌ای که در برنامه وجود ندارد (مسیرِ ناشناس، هشِ ناشناس یا ماژولِ نامعتبر)
 *    باید صفحه‌ی ۴۰۴ فارسی با دکمه‌ی «بازگشت به صفحه‌ی قبل» نشان دهد.
 * ۲) صفحه‌های واقعی (ریشه، ورود، راهنمای ماژول و بخش‌های صفحه‌ی اصلی) نباید ۴۰۴ شوند؛
 *    تشخیصِ ریشه‌ی برنامه باید با تگِ واقعیِ «script type="module" src="./assets/...» کار کند.
 * ۳) کاربرِ واردشده باید در صفحه‌ی ۴۰۴ میان‌برِ ماژول‌ها را ببیند و نشستش حفظ شود.
 */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { boot, createChecker, wait } from './harness.mjs';

const { check, state } = createChecker();
const ROOT = 'http://localhost:8080/';
const notFound = (doc) => Boolean(doc.querySelector('.not-found-page'));

/* ------------------ ۱) مسیرِ ناشناس: صفحه‌ی ۴۰۴ و دکمه‌ی بازگشت ------------------ */
{
  const { window, doc, errors } = await boot({ url: `${ROOT}settings/unknown/path`, offline: true, login: false });
  const back = doc.querySelector('#not-found-back');
  check('مسیرِ ناشناس صفحه‌ی ۴۰۴ نشان می‌دهد', notFound(doc));
  check('کدِ خطای ۴۰۴ در صفحه دیده می‌شود', (doc.querySelector('.not-found-chip')?.textContent ?? '').includes('۴۰۴'));
  check('دکمه‌ی «بازگشت به صفحه‌ی قبل» وجود دارد', (back?.textContent ?? '').includes('بازگشت به صفحه‌ی قبل'), back?.textContent?.trim() ?? '');
  check('نشانیِ درخواستی در صفحه نمایش داده می‌شود', (doc.querySelector('.not-found-address code')?.textContent ?? '').includes('/settings/unknown/path'), doc.querySelector('.not-found-address code')?.textContent ?? '');
  check('عنوانِ صفحه ۴۰۴ می‌شود', /۴۰۴/.test(doc.title), doc.title);
  check('نشانیِ کاربر دست‌نخورده می‌ماند (ریدایرکتِ گمراه‌کننده نمی‌شود)', window.location.pathname === '/settings/unknown/path', window.location.pathname);
  check('میان‌برهای مهمان (ورود به سامانه / معرفی ماژول‌ها) نمایش داده می‌شود', Boolean(doc.querySelector('#not-found-login, #not-found-modules')) || Boolean(doc.querySelector('.not-found-shortcuts-grid')), doc.querySelector('.not-found-shortcuts-grid')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  check('بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
}

/* ------------- ۲) دکمه‌ی «صفحه‌ی اصلی» و «آشنایی با ماژول‌ها» به ریشه می‌رود ------------- */
{
  const { window, doc } = await boot({ url: `${ROOT}no/such/page`, offline: true, login: false });
  doc.querySelector('#not-found-home')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  check('دکمه‌ی «صفحه‌ی اصلی» صفحه‌ی اصلی را نشان می‌دهد', Boolean(doc.querySelector('.landing-page')) && !notFound(doc), window.location.pathname);
  check('نشانیِ صفحه پس از کلیک روی «صفحه‌ی اصلی» ریشه‌ی برنامه است', window.location.pathname === '/', window.location.pathname);
}
{
  const { window, doc } = await boot({ url: `${ROOT}no/such/page`, offline: true, login: false });
  const loginHref = doc.querySelector('#not-found-login')?.getAttribute('href') ?? '';
  check('پیوندِ ورود در صفحه‌ی ۴۰۴ به ریشه‌ی برنامه اشاره می‌کند', loginHref === '/?login=1#login', loginHref || '—');
  doc.querySelector('#not-found-modules')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  check('میان‌برِ «آشنایی با ماژول‌ها» به صفحه‌ی اصلی می‌رود', Boolean(doc.querySelector('.landing-page')) && !notFound(doc));
}

/* ------------------ ۳) هشِ ناشناس و ماژولِ نامعتبر هم ۴۰۴ می‌شوند ------------------ */
for (const hash of ['#/dashboard', '#dashboard', '#modules/warehouse', '#modules/accounting/extra']) {
  const { doc } = await boot({ url: `${ROOT}${hash}`, offline: true, login: false });
  check(`هشِ ناشناس «${hash}» صفحه‌ی ۴۰۴ نشان می‌دهد`, notFound(doc));
}

/* ---------------- ۴) صفحه‌های واقعی نباید ۴۰۴ شوند (با تگِ واقعیِ اسکریپت) ---------------- */
for (const [label, url] of [
  ['ریشه‌ی برنامه', ROOT],
  ['ریشه با اسلش و نشانیِ index.html', `${ROOT}index.html`],
  ['بخشِ قیمت‌ها در صفحه‌ی اصلی', `${ROOT}#pricing`],
  ['بخشِ ویژگی‌ها در صفحه‌ی اصلی', `${ROOT}#features`],
  ['صفحه‌ی ورود', `${ROOT}#login`],
  ['صفحه‌ی ورود با پارامتر', `${ROOT}?login=1#login`],
  ['راهنمای ماژولِ معتبر', `${ROOT}#modules/accounting`],
]) {
  const { doc } = await boot({ url, offline: true, login: false, keepModuleScript: true });
  check(`${label} ۴۰۴ نمی‌شود`, !notFound(doc), doc.querySelector('.not-found-page') ? 'صفحه‌ی ۴۰۴ نمایش داده شد' : 'ok');
}

/* --------------- ۵) استقرار در زیرمسیر (GitHub Pages مثل /repo/) --------------- */
{
  const { doc } = await boot({ url: 'http://localhost:8080/repo/', offline: true, login: false, keepModuleScript: true });
  check('ریشه‌ی برنامه در زیرمسیر هم درست تشخیص داده می‌شود', Boolean(doc.querySelector('.landing-page')) && !notFound(doc));
  const unknown = await boot({ url: 'http://localhost:8080/repo/unknown', offline: true, login: false, keepModuleScript: true });
  check('مسیرِ ناشناس در زیرمسیر ۴۰۴ می‌شود', notFound(unknown.doc));
}

/* --------------- ۶) کاربرِ واردشده: میان‌برِ ماژول‌ها و حفظِ نشست --------------- */
{
  const { window, doc, errors } = await boot();
  if (!doc.querySelector('.app-shell')) {
    console.log('  ⚠ سرور در دسترس نیست؛ بخشِ کاربرِ واردشده بررسی نشد');
  } else {
    window.history.pushState({}, '', '/#/unknown-screen');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await wait(200);
    check('نشستِ کاربرِ واردشده با دیدنِ ۴۰۴ از بین نمی‌رود', notFound(doc) && Boolean(window.localStorage.getItem('erp-session') || window.localStorage.getItem('last-user')));
    const shortcuts = [...doc.querySelectorAll('[data-not-found-module]')];
    check('میان‌برِ ماژول‌ها برای کاربرِ واردشده نمایش داده می‌شود', shortcuts.length > 1, shortcuts.map((button) => button.dataset.notFoundModule).join(', '));
    const target = shortcuts.find((button) => button.dataset.notFoundModule === 'treasury') ?? shortcuts[1];
    target?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(900);
    check('کلیک روی میان‌بر، ماژول را باز می‌کند', Boolean(doc.querySelector('.app-shell')) && !notFound(doc), window.location.hash);
    check('بدون خطای اجرایی در حالتِ کاربرِ واردشده', errors.length === 0, errors.slice(0, 2).join(' | '));
  }
}

/* ------------- ۷) دکمه‌ی بازگشت، به صفحه‌ی قبلیِ تاریخچه برمی‌گردد ------------- */
{
  const { window, doc } = await boot({ url: `${ROOT}#modules/accounting`, offline: true, login: false, keepModuleScript: true });
  check('نقطه‌ی شروع، راهنمای ماژول است', Boolean(doc.querySelector('.module-guide-page')));
  window.history.pushState({}, '', '/#/somewhere-else');
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await wait(200);
  check('پس از تغییرِ مسیر، صفحه‌ی ۴۰۴ نمایش داده می‌شود', notFound(doc));
  doc.querySelector('#not-found-back')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(500);
  check('دکمه‌ی بازگشت به صفحه‌ی قبلی برمی‌گردد', Boolean(doc.querySelector('.module-guide-page')) && !notFound(doc), window.location.hash);
}

/* ---- ۸) صفحه‌ی مستقلِ 404.html (همان چیزی که هاستِ ایستا در هر عمقی سرو می‌کند) ---- */
{
  const page = readFileSync(new URL('../../scripts/templates/404.html', import.meta.url).pathname, 'utf8');
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => { if (!/Not implemented/.test(String(error.message))) errors.push(error.message); });
  const requested = [];
  const dom = new JSDOM(page, {
    runScripts: 'dangerously', url: 'http://localhost:8081/foo/bar/', pretendToBeVisual: true, virtualConsole,
    // شبیه‌سازیِ هاستِ ایستا: فقط ریشه‌ی برنامه (index.html) پاسخ می‌دهد
    beforeParse(window) {
      window.fetch = (input) => {
        const target = String(input);
        requested.push(target);
        return Promise.resolve({ ok: target === '/index.html', status: target === '/index.html' ? 200 : 404 });
      };
    },
  });
  const { window } = dom;
  await wait(150);
  const doc = window.document;
  check('صفحه‌ی مستقل: نشانیِ درخواستی نمایش داده می‌شود', (doc.querySelector('#not-found-address')?.textContent ?? '').includes('/foo/bar/'), doc.querySelector('#not-found-address')?.textContent ?? '');
  check('صفحه‌ی مستقل: دکمه‌ی بازگشت و پیوندهای ریشه پس از یافتنِ ریشه‌ی برنامه اصلاح می‌شوند', doc.querySelector('#not-found-back')?.getAttribute('href') === '/' && doc.querySelector('#not-found-home')?.getAttribute('href') === '/', `${doc.querySelector('#not-found-back')?.getAttribute('href')} · ${doc.querySelector('#not-found-home')?.getAttribute('href')}`);
  check('صفحه‌ی مستقل: پیوندِ ورود به ریشه‌ی برنامه اضافه می‌شود', (doc.querySelector('#not-found-login')?.getAttribute('href') ?? '') === '/?login=1#login', doc.querySelector('#not-found-login')?.getAttribute('href') ?? '—');
  check('صفحه‌ی مستقل: برای یافتنِ ریشه پوشه‌های والد آزموده می‌شوند', requested.length >= 3, requested.join(' → '));
  check('صفحه‌ی مستقل: بدون خطای اجرایی', errors.length === 0, errors.slice(0, 2).join(' | '));
}

console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
