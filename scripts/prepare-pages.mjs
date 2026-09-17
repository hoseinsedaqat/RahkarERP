/**
 * آماده‌سازیِ خروجیِ ساخت برای انتشار روی هاستِ ایستا (GitHub Pages، Netlify و …).
 * - فایل .nojekyll: جلوگیری از پردازشِ Jekyll (پوشه‌ها و فایل‌هایی که با _ شروع می‌شوند)
 * - فایل 404.html: صفحه‌ی اختصاصیِ «پیدا نشد» برای نشانی‌های ناشناس. این صفحه
 *   خودبسنده است (CSS، تصویر و فونتِ فارسی درونِ خودش) تا اگر در هر عمقی از
 *   نشانی سرو شود، مسیرهای نسبیِ دارایی‌های برنامه آن را نشکنند و فونتش هم
 *   دقیقاً مثلِ بقیه‌ی صفحه‌ها (وزیرمتن) باشد.
 *
 * اجرا: node scripts/prepare-pages.mjs [پوشه‌ی خروجی]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const outDir = process.argv[2] ?? 'dist';
const index = join(outDir, 'index.html');

if (!existsSync(index)) {
  console.error(`پوشه‌ی ${outDir} ساخته نشده است؛ ابتدا دستورِ ساخت را اجرا کنید.`);
  process.exit(1);
}

writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');

/* ------------------------- فونتِ فارسیِ صفحه‌ی ۴۰۴ ------------------------- */

/** وزن‌هایی که در صفحه‌ی ۴۰۴ به کار رفته‌اند (۴۰۰ متن، ۷۰۰/۸۰۰ عنوان و برچسب‌ها) */
const neededFaces = ['arabic-400', 'arabic-700', 'arabic-800', 'latin-400'];

/**
 * قاعده‌های @font-face صفحه‌ی ۴۰۴ را از همان `src/fonts.css` برنامه می‌سازد،
 * اما فایلِ فونت را به‌صورت base64 درونِ صفحه جا می‌دهد تا صفحه به هیچ فایلِ
 * بیرونی وابسته نباشد (در نشانی‌های تودرتو هم سالم بماند).
 */
function embeddedFontFaces() {
  const fontsCssPath = join(projectRoot, 'src', 'fonts.css');
  const fontsDirectory = join(projectRoot, 'src', 'assets', 'fonts');
  if (!existsSync(fontsCssPath) || !existsSync(fontsDirectory)) return '';
  const source = readFileSync(fontsCssPath, 'utf8');
  const faces = [];
  for (const block of source.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const weight = block.match(/font-weight:\s*(\d+)/)?.[1];
    const file = block.match(/fonts\/([\w-]+\.woff2)/)?.[1];
    const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
    if (!weight || !file || !range) continue;
    const key = file.replace('vazirmatn-', '').replace('-normal.woff2', '');
    if (!neededFaces.includes(key)) continue;
    const fontPath = join(fontsDirectory, file);
    if (!existsSync(fontPath)) continue;
    const base64 = readFileSync(fontPath).toString('base64');
    faces.push(
      `@font-face{font-family:'Vazirmatn';font-style:normal;font-weight:${weight};font-display:swap;`
      + `src:url(data:font/woff2;base64,${base64}) format('woff2');unicode-range:${range};}`,
    );
  }
  return faces.join('\n      ');
}

const notFoundTemplate = join(here, 'templates', '404.html');
if (existsSync(notFoundTemplate)) {
  const template = readFileSync(notFoundTemplate, 'utf8');
  const page = template.replace('/*__VAZIRMATN_FACES__*/', embeddedFontFaces());
  writeFileSync(join(outDir, '404.html'), page, 'utf8');
} else {
  copyFileSync(index, join(outDir, '404.html'));
}

console.log(`آماده برای انتشار: ${outDir} (شامل .nojekyll و صفحه‌ی ۴۰۴ با فونتِ وزیرمتن)`);
