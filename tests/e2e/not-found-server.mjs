/**
 * سناریوی end-to-end: کدِ وضعیتِ ۴۰۴ در سرور
 * یک نمونه‌ی سرور روی پورتِ آزاد بالا می‌آید و بررسی می‌کند:
 * ۱) نشانیِ ناشناس، صفحه‌ی «پیدا نشد» را با کدِ وضعیتِ واقعیِ ۴۰۴ برمی‌گرداند
 *    (نه ۲۰۰؛ چون ابزارهای سنجش و موتورهای جست‌وجو به کدِ وضعیت تکیه می‌کنند).
 * ۲) درخواستِ HEAD هم ۴۰۴ با همان سرآیندها می‌گیرد.
 * ۳) فایلِ ناموجود (با پسوند) هم ۴۰۴ می‌شود.
 * ۴) مسیرهای API دست‌نخورده‌اند: /api/health پاسخ ۲۰۰ و /api/nope پاسخِ ۴۰۴ جیسون می‌دهد.
 * ۵) صفحه‌ی ۴۰۴ خودبسنده است: به داراییِ برنامه وابسته نیست (در نشانی‌های تودرتو نمی‌شکند).
 */
import { existsSync, readFileSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChecker, wait } from './harness.mjs';

const base = new URL('../../', import.meta.url).pathname;
const port = 8097;
const { check, state } = createChecker();

// پیش‌نیاز: صفحه‌ی ۴۰۴ خروجی (همان چیزی که روی هاستِ ایستا منتشر می‌شود)
if (!existsSync(`${base}dist/index.html`)) {
  console.log('  ⚠ خروجیِ dist ساخته نشده است؛ ابتدا npm run build را اجرا کنید');
  process.exit(0);
}
if (!existsSync(`${base}dist/404.html`)) {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/prepare-pages.mjs dist', { cwd: base, stdio: 'ignore' });
}
check('فایلِ 404.html در خروجیِ ساخت وجود دارد', existsSync(`${base}dist/404.html`));
const notFoundPage = readFileSync(`${base}dist/404.html`, 'utf8');
check('صفحه‌ی ۴۰۴ خودبسنده است (به داراییِ برنامه وابسته نیست)', !/\.\/assets\//.test(notFoundPage), (notFoundPage.match(/src="[^"]*"/) ?? ['—'])[0]);
check('فونتِ وزیرمتن (همان فونتِ بقیه‌ی صفحه‌ها) درونِ صفحه‌ی ۴۰۴ جا گرفته است', (notFoundPage.match(/data:font\/woff2;base64,/g) ?? []).length >= 3 && notFoundPage.includes("font-family:'Vazirmatn'"), `${(notFoundPage.match(/data:font\/woff2;base64,/g) ?? []).length} وزن`);

const dataDir = mkdtempSync(join(tmpdir(), 'rahkar-404-'));
const child = spawn('node', ['--import', 'tsx', 'server/index.ts'], {
  cwd: base, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'ignore',
});
const get = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, { cache: 'no-store', ...init });
const health0 = async (onPort) => { try { const response = await fetch(`http://127.0.0.1:${onPort}/api/health`, { cache: 'no-store' }); return response.ok; } catch { return false; } };
const health = () => health0(port);

try {
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) { await wait(400); ready = await health(); }
  check('سرورِ آزمایشی بالا آمد', ready);
  if (ready) {
    const root = await get('/');
    check('ریشه‌ی برنامه با کدِ ۲۰۰ سرو می‌شود', root.status === 200, `وضعیت: ${root.status}`);

    const unknown = await get('/settings/unknown/path');
    const body = await unknown.text();
    check('نشانیِ ناشناس کدِ ۴۰۴ می‌دهد', unknown.status === 404, `وضعیت: ${unknown.status}`);
    check('پاسخِ ۴۰۴ یک صفحه‌ی HTML فارسی است', String(unknown.headers.get('content-type')).includes('text/html') && body.includes('صفحه پیدا نشد'));
    check('صفحه‌ی ۴۰۴ دکمه‌ی بازگشت دارد', body.includes('not-found-back') || body.includes('بازگشت به صفحه‌ی قبل'));

    const head = await fetch(`http://127.0.0.1:${port}/settings/unknown/path`, { method: 'HEAD' });
    check('درخواستِ HEAD برای نشانیِ ناشناس هم ۴۰۴ می‌گیرد', head.status === 404, `وضعیت: ${head.status}`);

    const missingFile = await get('/nope.js');
    check('فایلِ ناموجود (با پسوند) ۴۰۴ می‌شود', missingFile.status === 404, `وضعیت: ${missingFile.status}`);

    check('مسیرِ سلامتِ سرویس دست‌نخورده است (/api/health = ۲۰۰)', (await get('/api/health')).status === 200);
    const apiUnknown = await get('/api/nope');
    check('مسیرِ ناشناسِ API پاسخِ ۴۰۴ جیسون می‌دهد (نه صفحه‌ی HTML)', apiUnknown.status === 404 && String(apiUnknown.headers.get('content-type')).includes('application/json'), `وضعیت: ${apiUnknown.status}`);
  }
} finally {
  child.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}

/* ------- ۶) اگر فایلِ 404.html نباشد (اجرای Docker که فقط build می‌کند) ------- */
{
  // مانندِ استقرارِ سروری که فقط خروجیِ build را دارد: صفحه‌ی ۴۰۴ وجود ندارد،
  // پس سرور باید پوسته‌ی برنامه را با کدِ ۴۰۴ و یک <base> بفرستد تا خودِ برنامه
  // صفحه‌ی «پیدا نشد» را رسم کند و دارایی‌های نسبی در مسیرِ تودرتو نشکنند.
  const stored = `${base}dist/404.html`;
  const hidden = `${base}dist/404.html.off`;
  renameSync(stored, hidden);
  const altPort = port + 1;
  const altData = mkdtempSync(join(tmpdir(), 'rahkar-shell-'));
  const alt = spawn('node', ['--import', 'tsx', 'server/index.ts'], {
    cwd: base, env: { ...process.env, PORT: String(altPort), HOST: '127.0.0.1', DATA_DIR: altData }, stdio: 'ignore',
  });
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) { await wait(400); ready = await health0(altPort); }
    check('سرور بدونِ فایلِ 404.html هم بالا می‌آید', ready);
    if (ready) {
      const response = await fetch(`http://127.0.0.1:${altPort}/some/unknown/path`, { cache: 'no-store' });
      const body = await response.text();
      check('در این حالت هم کدِ وضعیتِ ۴۰۴ برگردانده می‌شود', response.status === 404, `وضعیت: ${response.status}`);
      check('پوسته‌ی برنامه با <base href="/"> فرستاده می‌شود تا دارایی‌ها نشکنند', /<base href="\/"/.test(body) && /assets\/index-/.test(body));
    }
  } finally {
    alt.kill('SIGTERM');
    renameSync(hidden, stored);
    rmSync(altData, { recursive: true, force: true });
  }
}

console.log(state.failures ? `\nناموفق: ${state.failures} مورد` : '\nهمه‌ی بررسی‌ها موفق ✓');
process.exit(state.failures ? 1 : 0);
