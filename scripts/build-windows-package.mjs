/**
 * ساختِ بسته‌ی آفلاینِ ویندوز: پوشه‌ای که بدون نصبِ چیزی (جز Node.js) اجرا می‌شود.
 * اجرا: npm run package:win
 * خروجی: dist-win/راهکار/
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const target = join(root, 'dist-win', 'راهکار');

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('خروجیِ ساخت یافت نشد؛ نخست «npm run build» را اجرا کنید.');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// خروجیِ فرانت‌اند، کدِ سرور و پایگاهِ داده
cpSync(join(root, 'dist'), join(target, 'dist'), { recursive: true });
cpSync(join(root, 'server'), join(target, 'server'), { recursive: true });
if (existsSync(join(root, 'database'))) cpSync(join(root, 'database'), join(target, 'database'), { recursive: true });

// یک package.json کمینه برای نصبِ وابستگی‌ها در مقصد (همان نسخه‌های قفل‌شده‌ی پروژه)
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(target, 'package.json'), JSON.stringify({
  name: 'aria-erp-portable',
  version: rootPackage.version ?? '1.0.0',
  private: true,
  type: 'module',
  engines: rootPackage.engines,
  scripts: { start: 'node --import tsx server/index.ts' },
  dependencies: rootPackage.dependencies ?? { pg: '^8.16.0', tsx: '^4.20.0' },
}, null, 2), 'utf8');
// نمونه‌ی تنظیمات؛ کاربر می‌تواند آن را به .env تغییر نام دهد
if (existsSync(join(root, '.env.example'))) cpSync(join(root, '.env.example'), join(target, '.env.example'));

// اسکریپت‌های راه‌اندازی
cpSync(join(root, 'scripts', 'windows', 'راه‌اندازی-ویندوز.bat'), join(target, 'راه‌اندازی.bat'));
cpSync(join(root, 'scripts', 'windows', 'بازکن-مرورگر.bat'), join(target, 'بازکن-مرورگر.bat'));
// نسخه‌ی متنیِ همین راهنما برای استفاده‌ی آفلاین
cpSync(join(root, 'docs', 'راهنما-نصب.md'), join(target, 'راهنما-نصب.txt'));

// راهنمای کوتاه
writeFileSync(join(target, 'بخوانید.txt'), [
  'راهکار — سامانه جامع سازمانی و مالی',
  '===========================================',
  '',
  'روش اجرا:',
  '  1. نرم‌افزار Node.js نسخه ۲۰.۱۹ یا بالاتر (۲۲، ۲۳ یا ۲۴) را نصب کنید: https://nodejs.org',
  '  2. روی «راه‌اندازی.bat» دوبار کلیک کنید.',
  '  3. در نخستین اجرا وابستگی‌ها نصب می‌شود (نیاز به اینترنت دارد).',
  '  4. مرورگر روی آدرس http://localhost:8080 باز می‌شود.',
  '',
  'نام کاربری و رمزِ پیش‌فرض:',
  '  admin / admin123',
  '  حتماً پس از نخستین ورود رمز را تغییر دهید.',
  '',
  'داده‌ها در پوشه‌ی «.data» کنارِ برنامه ذخیره می‌شوند؛ برای پشتیبان‌گیری',
  'از بخش «سازمان و ساختار شرکت ← پشتیبان‌گیری و بازگردانی» استفاده کنید',
  'یا همین پوشه را کپی بگیرید.',
  '',
].join('\r\n'), 'utf8');

console.log(`بسته‌ی ویندوز آماده شد: ${target}`);
console.log('برای فشرده‌سازی: روی پوشه راست‌کلیک ← Send to → Compressed (zipped) folder');
