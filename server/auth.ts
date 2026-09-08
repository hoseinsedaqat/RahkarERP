import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** نقش‌های سیستم؛ هر نقش مجموعه‌ای از دسترسی‌ها دارد و در UI نمایش داده می‌شود. */
export type RoleId = 'admin' | 'accountant' | 'sales' | 'warehouse' | 'viewer';

export type Permission =
  | 'events.read'
  | 'events.write'
  | 'accounting.read'
  | 'accounting.write'
  | 'treasury.read'
  | 'treasury.write'
  | 'sales.read'
  | 'sales.write'
  | 'purchasing.read'
  | 'purchasing.write'
  | 'inventory.read'
  | 'inventory.write'
  | 'payroll.read'
  | 'payroll.write'
  | 'identity.manage'
  | 'audit.read';

type RoleDefinition = { title: string; permissions: Permission[] };

const readOnly: Permission[] = ['events.read', 'accounting.read', 'sales.read', 'inventory.read'];

export const roles: Record<RoleId, RoleDefinition> = {
  admin: {
    title: 'مدیر سیستم',
    permissions: [
      'events.read', 'events.write',
      'accounting.read', 'accounting.write',
      'treasury.read', 'treasury.write',
      'sales.read', 'sales.write',
      'purchasing.read', 'purchasing.write',
      'inventory.read', 'inventory.write',
      'payroll.read', 'payroll.write',
      'identity.manage', 'audit.read',
    ],
  },
  accountant: {
    title: 'حسابدار',
    permissions: ['events.read', 'events.write', 'accounting.read', 'accounting.write', 'treasury.read', 'treasury.write', 'sales.read', 'purchasing.read', 'payroll.read'],
  },
  sales: { title: 'کارشناس فروش', permissions: ['events.read', 'events.write', 'sales.read', 'sales.write', 'inventory.read'] },
  warehouse: { title: 'انباردار', permissions: ['events.read', 'events.write', 'inventory.read', 'inventory.write', 'purchasing.read'] },
  viewer: { title: 'ناظر', permissions: readOnly },
};

export const isRole = (value: unknown): value is RoleId => typeof value === 'string' && Object.prototype.hasOwnProperty.call(roles, value);

export const roleTitle = (role: RoleId): string => roles[role]?.title ?? 'کاربر';

export const permissionsOf = (role: RoleId): Permission[] => roles[role]?.permissions ?? ['events.read'];

/** بررسی سریع دسترسی در مسیرهای API */
export const can = (role: RoleId, permission: Permission): boolean => permissionsOf(role).includes(permission);

/* ---------------------------------- رمز عبور ---------------------------------- */

const keyLength = 64;

/** حداقل الزامات گذرواژه؛ هنگام ساخت یا تغییر کاربر بررسی می‌شود */
export const passwordPolicy = { minLength: 8, requireDigit: true, requireLetter: true };
export function passwordError(password: string): string | null {
  const value = String(password ?? '');
  if (value.length < passwordPolicy.minLength) return `گذرواژه باید حداقل ${passwordPolicy.minLength} کاراکتر باشد`;
  if (passwordPolicy.requireLetter && !/[آ-یA-Za-z]/.test(value)) return 'گذرواژه باید شامل حرف باشد';
  if (passwordPolicy.requireDigit && !/[0-9۰-۹]/.test(value)) return 'گذرواژه باید شامل عدد باشد';
  return null;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, keyLength).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, digest] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const derived = scryptSync(password, salt, keyLength);
  const expected = Buffer.from(digest, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ------------------------------------ توکن ------------------------------------ */

/**
 * کلید امضای توکن.
 * - در محیط عملیاتی حتماً باید JWT_SECRET (حداقل ۳۲ کاراکتر) تنظیم شود؛ در غیر این صورت سرویس بالا نمی‌آید.
 * - در محیط توسعه، اگر کلیدی تنظیم نشده باشد، یک کلید تصادفیِ هر بار اجرا ساخته می‌شود
 *   تا هرگز از کلیدِ ثابتِ قابل حدس استفاده نشود.
 */
const configuredSecret = (process.env.JWT_SECRET ?? '').trim();
const isProduction = (process.env.NODE_ENV ?? '').trim() === 'production';
if (isProduction && configuredSecret.length < 32) {
  throw new Error('برای اجرای عملیاتی باید متغیر محیطی JWT_SECRET با حداقل ۳۲ کاراکتر تنظیم شود.');
}

const dataDirectory = resolve(process.cwd(), process.env.DATA_DIR ?? '.data');
const secretFile = join(dataDirectory, '.jwt-secret');

/**
 * اگر اپراتور کلیدی تنظیم نکرده باشد، یک کلید تصادفیِ قوی ساخته و در پوشه‌ی داده
 * (همان‌جا که store.json است) ذخیره می‌شود تا با هر بار اجرای سرویس عوض نشود؛
 * در غیر این صورت با هر راه‌اندازیِ دوباره‌ی سرور، همه‌ی نشست‌ها باطل می‌شدند.
 * این فایل هرگز در مخزن کد قرار نمی‌گیرد و فقط برای اجرای محلی/توسعه است.
 */
function loadOrCreateSecret(): string {
  try {
    if (existsSync(secretFile)) {
      const existing = readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    mkdirSync(dataDirectory, { recursive: true });
    const generated = randomBytes(48).toString('base64url');
    writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(secretFile, 0o600); } catch { /* در برخی سیستم‌فایل‌ها مجوزها پشتیبانی نمی‌شوند */ }
    return generated;
  } catch {
    // دسترسی به دیسک ممکن نیست (محیط فقط‌خواندنی): کلید فقط برای این اجرا معتبر است
    return randomBytes(48).toString('base64url');
  }
}

const secret = configuredSecret.length >= 16 ? configuredSecret : loadOrCreateSecret();
/** آیا کلید از متغیر محیطی نیامده است؟ (برای هشدار در لاگ و پنل وضعیت) */
export const usingEphemeralSecret = secret !== configuredSecret;

/** اثرِ کوتاهِ کلیدِ امضا (برای تشخیصِ عوض شدنِ سرویس؛ خودِ کلید هرگز فاش نمی‌شود) */
export const secretFingerprint = (): string =>
  createHmac('sha256', secret).update('rahkar-secret-fingerprint').digest('hex').slice(0, 10);

export type TokenPayload = {
  sub: string; username: string; displayName: string; role: RoleId;
  kind?: 'access' | 'refresh'; jti?: string; exp: number;
};

const encodePart = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const decodePart = <T>(value: string): T | null => {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
};

const sign = (data: string): string => createHmac('sha256', secret).update(data).digest('base64url');

/** صدور توکن امضاشده با الگوریتم HS256 و اعتبار پیش‌فرض ۸ ساعت */
export function signToken(payload: Omit<TokenPayload, 'exp'>, ttlSeconds = 8 * 60 * 60): string {
  const body: TokenPayload = { ...payload, kind: 'access', jti: randomBytes(12).toString('base64url'), exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const data = `${encodePart({ alg: 'HS256', typ: 'JWT' })}.${encodePart(body)}`;
  return `${data}.${sign(data)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(data));
  const received = Buffer.from(parts[2]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  const header = decodePart<{ alg?: string }>(parts[0]);
  // فقط الگوریتم HS256 پذیرفته می‌شود (جلوگیری از حمله‌ی alg:none)
  if (!header || header.alg !== 'HS256') return null;
  const payload = decodePart<TokenPayload>(parts[1]);
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.kind !== 'access') return null;
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

/** استخراج توکن از هدر Authorization: Bearer ... */
export function bearerToken(header: string | undefined): string | null {
  const value = String(header ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

/** نوع توکن: دسترسی کوتاه‌ع возраста یا تازه‌سازی بلندمدت */
export type TokenKind = 'access' | 'refresh';

export type RefreshPayload = { sub: string; username: string; displayName: string; role: RoleId; kind: TokenKind; jti?: string; exp: number };

/** امضای توکن تازه‌سازی (۳۰ روز) و دسترسی (۱۲ ساعت) */
export function signRefreshToken(payload: Omit<TokenPayload, 'exp'>, ttlSeconds = 30 * 24 * 60 * 60): string {
  const body = { ...payload, kind: 'refresh' as const, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const data = `${encodePart({ alg: 'HS256', typ: 'JWT' })}.${encodePart(body)}`;
  return `${data}.${sign(data)}`;
}

export function verifyRefreshToken(token: string): TokenPayload | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(data));
  const received = Buffer.from(parts[2]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  const payload = decodePart<RefreshPayload>(parts[1]);
  if (!payload || payload.kind !== 'refresh') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  return { sub: payload.sub, username: payload.username, displayName: payload.displayName, role: payload.role, kind: 'refresh' as const, jti: payload.jti, exp: payload.exp };
}
