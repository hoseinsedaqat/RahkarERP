/**
 * =====================================================================
 * ورودِ بیرونی: گوگل (Google Identity Services) و سوپابیس
 * =====================================================================
 * این ماژول فقط زمانی فعال است که کلیدهای مربوط در فایل .env تنظیم شده باشند.
 * هیچ کلیدی در کد وجود ندارد و هیچ کلیدی از کاربر گرفته نمی‌شود؛
 * همه‌چیز از متغیرهای محیطی خوانده می‌شود (نمونه‌ی کامل در .env.example).
 *
 * مسیرها:
 *   گوگل    → credential (توکنِ شناسه‌ی JWT) با Google بررسی می‌شود
 *   سوپابیس → توکنِ دسترسی با درخواست به /auth/v1/user بررسی می‌شود
 */

export type ExternalIdentity = {
  email: string;
  name: string;
  emailVerified: boolean;
  provider: 'google' | 'supabase';
  subject: string;
};

/** آیا ورود با گوگل فعال است؟ (تنظیمِ GOOGLE_CLIENT_ID در .env) */
export const googleEnabled = (): boolean => Boolean((process.env.GOOGLE_CLIENT_ID ?? '').trim());

/** آیا ورود با سوپابیس فعال است؟ */
export const supabaseEnabled = (): boolean =>
  Boolean((process.env.SUPABASE_URL ?? '').trim() && (process.env.SUPABASE_ANON_KEY ?? '').trim());

/** نقشِ پیش‌فرضِ کاربرانی که نخستین‌بار با گوگل وارد می‌شوند (کم‌دسترسی‌ترین حالت امن) */
export const defaultExternalRole = (): string => (process.env.GOOGLE_DEFAULT_ROLE ?? 'viewer').trim();

/** آیا اجازه‌ی ساختِ خودکارِ کاربرِ جدید داده شده است؟ */
export const autoSignupEnabled = (): boolean => (process.env.GOOGLE_AUTO_SIGNUP ?? 'false').trim().toLowerCase() === 'true';

/** دامنه‌های مجاز (اختیاری و بسیار توصیه‌شده)؛ خالی یعنی هر دامنه‌ای */
export const allowedDomains = (): string[] =>
  (process.env.GOOGLE_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

const withTimeout = async (url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/** بررسیِ توکنِ شناسه‌ی گوگل از طریق endpoint رسمیِ خود گوگل */
async function verifyWithGoogle(credential: string): Promise<ExternalIdentity | null> {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? '').trim();
  if (!clientId) return null;
  try {
    const response = await withTimeout(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    const audience = String(payload.aud ?? '');
    const email = String(payload.email ?? '').trim().toLowerCase();
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    const expires = Number(payload.exp ?? 0);
    if (audience !== clientId) return null;
    if (!email || !verified) return null;
    if (expires && expires * 1000 < Date.now()) return null;
    return {
      email,
      name: String(payload.name ?? email.split('@')[0]).trim() || email,
      emailVerified: true,
      provider: 'google',
      subject: String(payload.sub ?? email),
    };
  } catch {
    return null;
  }
}

/** بررسیِ توکنِ دسترسیِ سوپابیس */
async function verifyWithSupabase(accessToken: string): Promise<ExternalIdentity | null> {
  const base = (process.env.SUPABASE_URL ?? '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_ANON_KEY ?? '').trim();
  if (!base || !key) return null;
  try {
    const response = await withTimeout(`${base}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: key },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    const email = String(payload.email ?? '').trim().toLowerCase();
    if (!email) return null;
    const identities = Array.isArray(payload.identities) ? payload.identities : [];
    const googleIdentity = identities.find((item) => String((item as Record<string, unknown>).provider ?? '') === 'google');
    return {
      email,
      name: String((payload.user_metadata as Record<string, unknown> | undefined)?.full_name ?? email.split('@')[0]).trim() || email,
      emailVerified: Boolean(payload.email_confirmed_at) || Boolean(googleIdentity),
      provider: 'supabase',
      subject: String(payload.id ?? email),
    };
  } catch {
    return null;
  }
}

/**
 * بررسیِ اعتبارنامه‌ی بیرونی. خروجی null یعنی اعتبارنامه پذیرفته نشد.
 * ترتیب: اگر اعتبارنامه شبیه JWT است و گوگل فعال است ← گوگل؛ وگرنه سوپابیس.
 */
export async function verifyExternalCredential(credential: string): Promise<ExternalIdentity | null> {
  const token = String(credential ?? '').trim();
  if (!token) return null;
  const looksLikeJwt = token.split('.').length === 3;
  if (looksLikeJwt && googleEnabled()) {
    const identity = await verifyWithGoogle(token);
    if (identity) return identity;
  }
  if (supabaseEnabled()) return verifyWithSupabase(token);
  if (!looksLikeJwt && googleEnabled()) return verifyWithGoogle(token);
  return null;
}

/** آیا ایمیلِ کاربر اجازه‌ی ورود دارد؟ (محدودیتِ دامنه در صورت تنظیم) */
export function domainAllowed(email: string): boolean {
  const list = allowedDomains();
  if (!list.length) return true;
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return list.includes(domain);
}
