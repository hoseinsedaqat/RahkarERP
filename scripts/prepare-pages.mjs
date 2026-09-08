/**
 * آماده‌سازیِ خروجیِ ساخت برای انتشار روی GitHub Pages.
 * - فایل .nojekyll: جلوگیری از پردازشِ Jekyll (پوشه‌ها و فایل‌هایی که با _ شروع می‌شوند)
 * - فایل 404.html: برگرداندنِ صفحه‌ی اصلی برای نشانی‌های ناشناس (برنامه تک‌صفحه‌ای است)
 *
 * اجرا: node scripts/prepare-pages.mjs [پوشه‌ی خروجی]
 */
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'dist';
const index = join(outDir, 'index.html');

if (!existsSync(index)) {
  console.error(`پوشه‌ی ${outDir} ساخته نشده است؛ ابتدا دستورِ ساخت را اجرا کنید.`);
  process.exit(1);
}

writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');
copyFileSync(index, join(outDir, '404.html'));
console.log(`آماده برای انتشار: ${outDir} (شامل .nojekyll و 404.html)`);
