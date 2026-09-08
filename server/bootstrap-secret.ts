/**
 * راه‌اندازِ کلیدِ امضای توکن — باید پیش از هر ماژولِ دیگری (به‌ویژه auth.ts) بارگذاری شود.
 * ---------------------------------------------------------------------------------------
 * چرا این فایل وجود دارد؟
 *   auth.ts در لحظه‌ی بارگذاری، کلیدِ امضای JWT را از process.env.JWT_SECRET می‌خواند.
 *   اگر اپراتور کلیدی تنظیم نکرده باشد، باید کلیدی «پایدار» ساخته شود؛ وگرنه با هر بار
 *   راه‌اندازیِ سرور همه‌ی نشست‌ها باطل می‌شوند و کاربران مدام بیرون می‌افتند.
 *
 * ترتیبِ اولویت برای پیدا کردنِ کلید:
 *   ۱) متغیر محیطی JWT_SECRET (از سیستم یا فایل .env کنارِ پروژه)
 *   ۲) کلیدِ ذخیره‌شده در پایگاهِ فایل (.data/store.json ← jwtSecret) — با پشتیبان‌ها جابه‌جا می‌شود
 *   ۳) فایلِ .data/.jwt-secret
 *   ۴) ساختِ یک کلیدِ تصادفیِ قوی و ذخیره‌ی آن در .data/.jwt-secret برای اجراهای بعدی
 *
 * نتیجه: چه NODE_ENV=production باشد چه نباشد، سرور همیشه با یک کلیدِ معتبر (≥ ۳۲ کاراکتر)
 * و ثابت بالا می‌آید و نیازی به پیکربندیِ دستی برای اجرای محلی/ویندوزی نیست.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const minimumLength = 32;

/* ------------------------------- بارگذاریِ فایل .env ------------------------------- */

/**
 * فایل .env (در ریشه‌ی پروژه) بدون نیاز به کتابخانه‌ی خارجی خوانده می‌شود.
 * مقادیری که از قبل در محیط تنظیم شده‌اند، بازنویسی نمی‌شوند (اولویت با سیستم است).
 */
function loadDotEnv(): void {
  const envFile = resolve(process.cwd(), process.env.ENV_FILE ?? '.env');
  if (!existsSync(envFile)) return;
  try {
    const content = readFileSync(envFile, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim().replace(/^export\s+/, '');
      let value = line.slice(separator + 1).trim();
      // حذفِ نقل‌قول‌های دورِ مقدار و توضیحِ انتهای خط
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        const comment = value.indexOf(' #');
        if (comment >= 0) value = value.slice(0, comment).trim();
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    console.warn(`خواندنِ فایل .env ممکن نشد: ${(error as Error).message}`);
  }
}

/* ------------------------------- پیدا کردنِ کلیدِ پایدار ------------------------------- */

const dataDirectory = (): string => resolve(process.cwd(), process.env.DATA_DIR ?? '.data');

function secretFromStore(): string | null {
  const storeFile = join(dataDirectory(), 'store.json');
  if (!existsSync(storeFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(storeFile, 'utf8')) as { jwtSecret?: unknown };
    const value = typeof parsed.jwtSecret === 'string' ? parsed.jwtSecret.trim() : '';
    return value.length >= minimumLength ? value : null;
  } catch {
    return null;
  }
}

function secretFromFile(): string | null {
  const secretFile = join(dataDirectory(), '.jwt-secret');
  if (!existsSync(secretFile)) return null;
  try {
    const value = readFileSync(secretFile, 'utf8').trim();
    return value.length >= minimumLength ? value : null;
  } catch {
    return null;
  }
}

function createAndPersistSecret(): string {
  const generated = randomBytes(48).toString('base64url');
  try {
    mkdirSync(dataDirectory(), { recursive: true });
    const secretFile = join(dataDirectory(), '.jwt-secret');
    writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(secretFile, 0o600); } catch { /* روی برخی سیستم‌فایل‌ها (مانند ویندوز) مجوزها پشتیبانی نمی‌شوند */ }
  } catch (error) {
    console.warn(`ذخیره‌ی کلیدِ امضا ممکن نشد؛ کلید فقط برای این اجرا معتبر است: ${(error as Error).message}`);
  }
  return generated;
}

/* ------------------------------------- اجرا ------------------------------------- */

loadDotEnv();

const configured = (process.env.JWT_SECRET ?? '').trim();

if (configured.length >= minimumLength) {
  // کلید توسط اپراتور تنظیم شده است؛ دست نمی‌زنیم
  process.env.JWT_SECRET = configured;
} else {
  if (configured.length > 0) {
    console.warn(`JWT_SECRET کوتاه‌تر از ${minimumLength} کاراکتر است و نادیده گرفته شد؛ از کلیدِ پایدارِ خودکار استفاده می‌شود.`);
  }
  const secret = secretFromStore() ?? secretFromFile() ?? createAndPersistSecret();
  process.env.JWT_SECRET = secret;
  // به store.ts می‌گوید این کلید را در پایگاه هم نگه دارد تا با پشتیبان‌ها جابه‌جا شود
  process.env.RAHKAR_GENERATED_SECRET = '1';
}

export {};
