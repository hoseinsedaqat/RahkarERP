/** نخستین import: کلیدِ امضای توکن پیش از بارگذاریِ auth.ts پایدار می‌شود
 *  (در غیر این صورت با هر راه‌اندازیِ سرور همه‌ی نشست‌ها باطل می‌شدند) */
import './bootstrap-secret.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { buildTaxInvoicePayload, sendInvoiceToTaxSystem, taxSettings } from './tax-gateway.js';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import {
  bearerToken,
  can,
  permissionsOf,
  roleTitle,
  signRefreshToken,
  signToken,
  verifyPassword,
  verifyRefreshToken,
  verifyToken,
  secretFingerprint,
  passwordError,
  isRole,
  type Permission,
  type RoleId,
  type TokenPayload,
} from './auth.js';
import { verifyExternalCredential, googleEnabled, supabaseEnabled, defaultExternalRole, autoSignupEnabled, domainAllowed } from './external-auth.js';
import { randomBytes } from 'node:crypto';
import { analyzeBudget, applyActualFromAccounts, type BudgetLineInput } from './budget-engine.js';
import { REPORT_SOURCES, runReport, type ReportDefinition } from './report-engine.js';
import { estimateUnitCost, productionCost, type ProductionCostInput } from './manufacturing-engine.js';
import { DEPRECIATION_METHODS, depreciationRun, depreciationSchedule, type DepreciableAsset, type DepreciationMethod } from './assets-engine.js';
import * as store from './store.js';
import { createBom, deleteBom, findBom, listBoms } from './store.js';
import { createSerials, listSerials, serialsSummary, updateSerialStatus, type SerialStatus } from './store.js';
import { findTransition, transitions as workflowTransitions, type WorkflowStatus } from './workflow.js';
import { startAutoBackup, listBackups, takeBackup, backupPath } from './auto-backup.js';
import { runMigrations } from './migrations.js';
import { buildJournal, isPostingSource, sourceByModule, vatOf } from './accounting-engine.js';
import { calculatePayroll } from './payroll-engine.js';
import { seedDatabase } from './seed.js';
import { createAccount, createFixedAsset, createJournal, createPayroll, createProductionOrder, createPurchaseOrder, createSalesInvoice, createTreasury, deleteAccount, insertEvent, listAccountBalances, listAccounts, listEmployees, listEvents as listEventsFromDatabase, listFixedAssets, listInventory, listProductionOrders, listPurchaseOrders, listSalesInvoices, listTreasury } from './database.js';

const port = Number(process.env.PORT ?? 4000);
/** مبدأهای مجاز برای CORS؛ مقدار پیش‌فرض «*» است چون احراز هویت بر پایه‌ی توکن است نه کوکی. */
/* ------------------------------ امنیت پایه ------------------------------ */

/** مبدأهای مجاز برای CORS: پیش‌فرض «همان مبدأ»؛ با CORS_ORIGIN قابل گسترش است */
const isProduction = (process.env.NODE_ENV ?? '').trim() === 'production';
const configuredOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
const allowAnyOrigin = configuredOrigins.includes('*') && !isProduction;
const corsHeadersFor = (request: IncomingMessage): Record<string, string> => {
  const origin = String(request.headers.origin ?? '').trim();
  let allowed = '';
  if (allowAnyOrigin) allowed = origin || '*';
  else if (origin && configuredOrigins.includes(origin)) allowed = origin;
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token, X-Organization-Id, X-Org-Id',
    'Access-Control-Max-Age': '600',
  };
};

/** سرآیندهای امنیتی برای همه‌ی پاسخ‌ها */
const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};
if ((process.env.TRUST_PROXY ?? '') === 'true') securityHeaders['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';

/** افزودن خودکارِ سرآیندهای امنیتی و CORS به همه‌ی پاسخ‌های یک درخواست */
const decorateResponse = (request: IncomingMessage, result: ServerResponse): void => {
  const cors = corsHeadersFor(request);
  const original = result.writeHead.bind(result);
  result.writeHead = ((status: number, headers?: Record<string, string>) => {
    original(status, { ...securityHeaders, ...headers, ...cors });
    return result;
  }) as typeof result.writeHead;
};

/** محدودسازی نرخ درخواست برای جلوگیری از حمله‌ی رمزعبور و فشار روی سرویس */
type RateBucket = { count: number; resetAt: number; blockedUntil?: number };
const rateBuckets = new Map<string, RateBucket>();
const rateWindowMs = 10 * 60 * 1000;
let rateCleanupAt = Date.now() + rateWindowMs;

function rateLimit(key: string, limit: number, windowMs = rateWindowMs): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  if (now > rateCleanupAt) {
    for (const [bucketKey, bucket] of rateBuckets) if (bucket.resetAt < now) rateBuckets.delete(bucketKey);
    rateCleanupAt = now + windowMs;
  }
  const bucket = rateBuckets.get(key) ?? { count: 0, resetAt: now + windowMs };
  if (bucket.blockedUntil && bucket.blockedUntil > now) return { allowed: false, retryAfter: Math.ceil((bucket.blockedUntil - now) / 1000) };
  if (bucket.resetAt < now) { bucket.count = 0; bucket.resetAt = now + windowMs; bucket.blockedUntil = undefined; }
  bucket.count += 1;
  if (bucket.count > limit) {
    const step = Math.min(8, Math.ceil(bucket.count / limit));
    bucket.blockedUntil = now + step * 60 * 1000;
    rateBuckets.set(key, bucket);
    return { allowed: false, retryAfter: Math.ceil((bucket.blockedUntil - now) / 1000) };
  }
  rateBuckets.set(key, bucket);
  return { allowed: true, retryAfter: 0 };
}

/** کلیدِ محدودسازی بر پایه‌ی نشانی کاربر */
function clientKey(request: IncomingMessage, scope = ''): string {
  const forwarded = request.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' && forwarded.length
    ? forwarded.split(',')[0].trim()
    : (request.socket.remoteAddress ?? 'unknown');
  return `${scope}:${ip}`;
}

/** پاک‌سازی ورودی از کلیدهای خطرناک (جلوگیری از آلودگیِ نمونه‌اولیه) */
function sanitize<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sanitize(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      output[key] = sanitize(item);
    }
    return output as T;
  }
  return value;
}

const maxBodyBytes = Number(process.env.MAX_BODY_BYTES ?? 2 * 1024 * 1024);

/**
 * اثرِ دستگاه: ترکیبی از نشانیِ کاربر و مرورگر.
 * برای این‌که چند تبِ خودِ کاربر یا تکرارِ یک درخواست، با دستگاهِ مهاجم اشتباه گرفته نشود.
 */
function deviceFingerprint(request: IncomingMessage): string {
  return `${clientKey(request)}|${String(request.headers['user-agent'] ?? '').slice(0, 120)}`;
}

/** خواندن بدنه‌ی JSON با محدودیتِ اندازه و پاک‌سازی */
async function readJsonBody<T>(request: IncomingMessage, result: ServerResponse): Promise<T | null> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > maxBodyBytes) { fail(result, 'حجم درخواست بیش از حد مجاز است', 413); return null; }
  let raw = '';
  try {
    raw = await new Promise<string>((done, reject) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk ?? '');
        if (body.length > maxBodyBytes) { reject(new Error('too-large')); request.destroy(); return; }
      });
      request.on('end', () => done(body));
      request.on('error', reject);
    });
  } catch {
    fail(result, 'حجم درخواست بیش از حد مجاز است', 413);
    return null;
  }
  if (!raw.trim()) { fail(result, 'بدنه‌ی درخواست خالی است'); return null; }
  try {
    return sanitize(JSON.parse(raw) as T);
  } catch {
    fail(result, 'بدنه‌ی درخواست معتبر نیست');
    return null;
  }
}


/**
 * شناسه‌ی این اجرا از سرویس و اثرِ کلیدِ امضا.
 * با فرستادنِ این دو در هر پاسخ، برنامه می‌تواند تشخیص دهد که آیا بینِ دو درخواست
 * سرویس عوض شده است (میزبانیِ موقت، چند نمونه، راه‌اندازیِ دوباره) یا نه؛
 * در غیر این صورت یک خطای ۴۰۱ ساده هیچ توضیحی به همراه ندارد.
 */
const serverId = randomUUID().slice(0, 8);
const serverStartedAt = Date.now();
const serverHeaders = (): Record<string, string> => ({ 'X-Server-Id': serverId, 'X-Secret-Id': secretFingerprint() });

const response = (payload: unknown, status = 200) => ({ status, body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json; charset=utf-8', ...serverHeaders() } });
const moduleIds = ['identity', 'organization', 'workflow', 'integration', 'accounting', 'treasury', 'sales', 'purchasing', 'inventory', 'payroll', 'hr', 'fixed-assets', 'manufacturing', 'budget', 'crm', 'reporting'];
const organizationName = process.env.ORGANIZATION_NAME ?? 'گروه صنعتی آریا';
const usingDatabase = Boolean(process.env.DATABASE_URL);

const readBody = (request: IncomingMessage): Promise<string> => new Promise((done) => { let body = ''; request.on('data', (chunk) => { body += String(chunk ?? ''); }); request.on('end', () => done(body)); });
type Outgoing = { status: number; body: string | Buffer; headers: Record<string, string> };
const send = (result: ServerResponse, output: Outgoing) => { result.writeHead(output.status, output.headers); result.end(output.body); };
const fail = (result: ServerResponse, message: string, status = 400, code?: string) =>
  send(result, response(code ? { error: message, code } : { error: message }, status));

/* --------------------------------- احراز هویت --------------------------------- */

/** شرکتِ فعلیِ درخواست برای مسیرهای فقط‌خواندنی (در نبودِ توکن، شرکتِ پیش‌فرض) */
const requestedOrganization = (request: IncomingMessage): string => {
  const payload = authenticate(request);
  if (payload) return resolveOrganization(request, payload);
  const requested = String(request.headers['x-organization-id'] ?? request.headers['x-org-id'] ?? '').trim();
  return requested || 'org-default';
};

/**
 * توکنِ دسترسیِ درخواست را از هر جایی که رسیده باشد برمی‌دارد.
 * چرا چند مسیر؟ برخی پروکسی‌ها/CDNها (مانند پیش‌نمایشِ Cloudflare/e2b و بعضی
 * تونل‌ها) هدرِ استانداردِ Authorization را از درخواست حذف می‌کنند؛ در این حالت
 * کاربر با رمزِ درست وارد می‌شد اما همه‌ی درخواست‌های بعدی ۴۰۱ می‌گرفتند و برنامه
 * سه ثانیه بعد از داشبورد بیرون می‌افتاد. برای این‌که اتصال به زیرساخت وابسته نباشد:
 *   ۱) Authorization: Bearer …           (استاندارد)
 *   ۲) X-Auth-Token: …                     (هدرِ اختصاصی؛ پروکسی‌ها به آن دست نمی‌زنند)
 *   ۳) کوکیِ rahkar_token (SameSite=Strict) (مسیرِ پشتیبان برای همان مبدأ)
 */
/** نامِ کوکیِ نشست و عمرِ توکن‌ها (نشست ۳۰ روزه؛ توکنِ دسترسی بی‌صدا تازه می‌شود) */
const SESSION_COOKIE = 'rahkar_token';
const ACCESS_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
function cookieValue(request: IncomingMessage, name: string): string | null {
  const raw = String(request.headers.cookie ?? '');
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return part.slice(separator + 1).trim(); }
    }
  }
  return null;
}
const authDebug = process.env.AUTH_DEBUG === '1';
function requestToken(request: IncomingMessage): string | null {
  const bearer = bearerToken(request.headers.authorization);
  const custom = String(request.headers['x-auth-token'] ?? '').trim();
  const cookie = cookieValue(request, SESSION_COOKIE);
  if (authDebug) console.log(`[auth-debug] ${request.method} ${request.url} bearer=${bearer ? 'yes' : 'no'} x-auth-token=${custom ? 'yes' : 'no'} cookie=${cookie ? 'yes' : 'no'}`);
  if (bearer) return bearer;
  if (custom) return custom;
  // کوکی فقط برای درخواست‌های هم‌مبدأ پذیرفته می‌شود (سدِ CSRF علاوه بر SameSite=Strict)
  const origin = String(request.headers.origin ?? '');
  if (origin) {
    try {
      if (new URL(origin).host !== String(request.headers.host ?? '')) return null;
    } catch { return null; }
  }
  return cookie;
}

const isSecureRequest = (request: IncomingMessage): boolean =>
  String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' || Boolean((request.socket as { encrypted?: boolean }).encrypted);
/** پاسخِ ورود/تازه‌سازی: توکن در بدنه + همان توکن در کوکیِ HttpOnly به‌عنوان مسیرِ پشتیبان */
function sessionResponse(request: IncomingMessage, payload: unknown, token: string | null): Outgoing {
  const base = response(payload);
  const attributes = [`Path=/api`, 'HttpOnly', 'SameSite=Strict', isSecureRequest(request) ? 'Secure' : ''].filter(Boolean).join('; ');
  const cookie = token
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${ACCESS_TTL_SECONDS}; ${attributes}`
    : `${SESSION_COOKIE}=; Max-Age=0; ${attributes}`;
  return { ...base, headers: { ...base.headers, 'Set-Cookie': cookie } };
}

const authenticate = (request: IncomingMessage): TokenPayload | null => {
  const token = requestToken(request);
  return token ? verifyToken(token) : null;
};

/** بررسی توکن و دسترسی؛ در صورت نقص، پاسخ مناسب ارسال و null برگردانده می‌شود */
const authorize = (request: IncomingMessage, result: ServerResponse, permission: Permission): TokenPayload | null => {
  const payload = authenticate(request);
  if (!payload) { fail(result, 'نشست شما پایان یافته است؛ لطفاً دوباره وارد شوید.', 401, 'AUTH_REQUIRED'); return null; }
  if (!can(payload.role, permission)) { fail(result, `نقش «${roleTitle(payload.role)}» دسترسی لازم را ندارد.`, 403); return null; }
  return payload;
};

/**
 * تعیین شرکتِ فعالِ درخواست: هدر x-organization-id اگر کاربر عضو آن شرکت باشد،
 * وگرنه شرکت پیش‌فرضِ کاربر. همه‌ی داده‌ها با این شناسه تفکیک می‌شوند.
 */
const resolveOrganization = (request: IncomingMessage, payload: TokenPayload): string => {
  const memberships = storeListMembershipsSync(payload.sub);
  const requested = String(request.headers['x-organization-id'] ?? request.headers['x-org-id'] ?? '').trim();
  if (requested && memberships.some((row) => row.organizationId === requested)) return requested;
  return memberships.find((row) => row.isDefault)?.organizationId ?? memberships[0]?.organizationId ?? '';
};

/** فهرست عضویت‌های کاربر (نسخه‌ی همگام؛ داده در حافظه است) */
function storeListMembershipsSync(userId: string): Array<{ organizationId: string; role: string; isDefault: boolean }> {
  return store.snapshotMemberships(userId);
}

/* ------------------------------ فایل‌های استاتیک ------------------------------ */

/** سرو فایل‌های استاتیک خروجی Vite در صورت وجود، برای اجرای تک‌فرآیندی frontend و API */
const distDirectory = resolve(process.cwd(), 'dist');
const serveStatic = process.env.SERVE_STATIC ? process.env.SERVE_STATIC !== 'false' : existsSync(join(distDirectory, 'index.html'));
const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8', '.zip': 'application/zip', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
/**
 * سروِ فایل‌های ثابت با پشتیبانیِ کامل از «دانلود» :
 *  - پاسخ به درخواستِ HEAD (برنامه‌هایی مانند Internet Download Manager نخست
 *    همین درخواست را می‌فرستند؛ اگر بی‌پاسخ بماند خطای «سرور یافت نشد» می‌دهند)
 *  - فرستادنِ Content-Length (برنامه‌های دانلود بدونِ آن اندازه را نمی‌فهمند)
 *  - پشتیبانی از Range/دریافتِ بخشی برای ادامه‌ی دانلود و چندبخشی کردن
 *  - برچسبِ attachment برای فایل‌های زیپ تا مرورگر آن‌ها را ذخیره کند
 */
const serveStaticFile = (request: IncomingMessage, result: ServerResponse, urlPath: string): boolean => {
  const requested = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(distDirectory, requested);
  if (!filePath.startsWith(distDirectory)) return false;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // فقط مسیرهای بدون پسوند (مسیرهای SPA) به index.html هدایت می‌شوند؛ فایل‌های مفقود 404 می‌گیرند
    if (extname(filePath)) return false;
    filePath = join(distDirectory, 'index.html');
  }
  if (!existsSync(filePath)) return false;

  const extension = extname(filePath);
  const stats = statSync(filePath);
  const headers: Record<string, string> = {
    'Content-Type': mimeTypes[extension] ?? 'application/octet-stream',
    'Content-Length': String(stats.size),
    'Accept-Ranges': 'bytes',
    'Last-Modified': stats.mtime.toUTCString(),
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  };
  const isHead = request.method === 'HEAD';

  // دریافتِ بخشی (ادامه‌ی دانلود / دانلودِ چندبخشی)
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? '').trim());
  if (range) {
    const total = stats.size;
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (range[1] === '') { // bytes=-500 یعنی ۵۰۰ بایتِ پایانی
      const length = Number(range[2] ?? 0);
      start = Math.max(0, total - length);
      end = total - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      result.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` });
      result.end();
      return true;
    }
    result.writeHead(206, {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    });
    if (isHead) { result.end(); return true; }
    createReadStream(filePath, { start, end }).pipe(result);
    return true;
  }

  result.writeHead(200, headers);
  if (isHead) { result.end(); return true; }
  createReadStream(filePath).pipe(result);
  return true;
};

/* ----------------------------------- مسیرها ----------------------------------- */

const server = createServer((request: IncomingMessage, result: ServerResponse) => {
  // سرآیندهای امنیتی و CORS برای همه‌ی پاسخ‌های این درخواست
  decorateResponse(request, result);
  if (request.method === 'OPTIONS') { result.writeHead(204); result.end(); return; }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  if (serveStatic && !path.startsWith('/api/') && serveStaticFile(request, result, url.pathname + url.search)) return;

  const route = async (): Promise<void> => {
    if (path === '/api/health') {
      const statistics = await store.stats();
      send(result, response({ ok: true, service: 'erp-api', storage: usingDatabase ? 'postgresql' : 'file', database: usingDatabase, serverId, secretId: secretFingerprint(), uptimeSeconds: Math.round((Date.now() - serverStartedAt) / 1000), statistics, timestamp: new Date().toISOString() }));
      return;
    }

    if (path === '/api/modules') { send(result, response({ data: moduleIds, count: moduleIds.length })); return; }
    if (path.startsWith('/api/modules/')) {
      const moduleId = path.split('/').pop() ?? '';
      if (!moduleIds.includes(moduleId)) { fail(result, 'ماژول پیدا نشد', 404); return; }
      send(result, response({ id: moduleId, status: 'ready', eventDriven: true, accountingBridge: true }));
      return;
    }

    /* ------------------------- ورود و وضعیت نشست ------------------------- */

    /* --------------------------------- احراز هویت --------------------------------- */

    /** تنظیماتِ ورودِ بیرونی برای ظاهرِ برنامه (فقط اطلاعاتِ غیرمحرمانه) */
    if (path === '/api/auth/config' && request.method === 'GET') {
      send(result, response({
        google: googleEnabled(),
        googleClientId: (process.env.GOOGLE_CLIENT_ID ?? '').trim(),
        supabase: supabaseEnabled(),
        autoSignup: autoSignupEnabled(),
      }));
      return;
    }

    /**
     * ورود با حساب گوگل (یا سوپابیس):
     * برنامه توکنِ شناسه‌ی گوگل را می‌فرستد، سرور آن را با خودِ گوگل بررسی می‌کند
     * و در صورت تأیید همان نشستِ معمول را صادر می‌کند.
     */
    if (path === '/api/auth/google' && request.method === 'POST') {
      const input = await readJsonBody<{ credential?: string }>(request, result);
      if (!input) return;
      const limiter = rateLimit(`google-login|${clientKey(request)}`, 10);
      if (!limiter.allowed) { fail(result, `تلاش‌های ورود زیاد بود؛ ${limiter.retryAfter} ثانیه دیگر دوباره تلاش کنید.`, 429); return; }
      const identity = await verifyExternalCredential(String(input.credential ?? ''));
      if (!identity) {
        await store.recordAudit({ actor: 'ناشناس', action: 'login.google.failed', entity: 'user', detail: 'اعتبارنامه نامعتبر' }).catch(() => undefined);
        fail(result, 'ورود با گوگل تأیید نشد. دوباره تلاش کنید.', 401);
        return;
      }
      if (!domainAllowed(identity.email)) {
        await store.recordAudit({ actor: identity.email, action: 'login.google.blocked', entity: 'user', detail: 'دامنه مجاز نیست' }).catch(() => undefined);
        fail(result, 'ورود با این دامنه‌ی ایمیل مجاز نیست.', 403);
        return;
      }
      let user = await store.findUser(identity.email);
      if (!user && autoSignupEnabled()) {
        const configured = defaultExternalRole();
        const role: RoleId = isRole(configured) ? configured : 'viewer';
        try {
          await store.createUser({ username: identity.email, displayName: identity.name, password: randomBytes(24).toString('hex'), role });
          user = await store.findUser(identity.email);
          await store.recordAudit({ actor: identity.email, action: 'user.auto-created', entity: 'user', detail: identity.provider }).catch(() => undefined);
        } catch { user = undefined; }
      }
      if (!user || !user.isActive) {
        await store.recordAudit({ actor: identity.email, action: 'login.google.denied', entity: 'user', detail: 'کاربر فعال نیست' }).catch(() => undefined);
        fail(result, 'حساب کاربری فعالی با این ایمیل در سیستم تعریف نشده است.', 403);
        return;
      }
      const claims = { sub: user.id, username: user.username, displayName: user.displayName, role: user.role };
      const token = signToken(claims, ACCESS_TTL_SECONDS);
      const refreshTtl = REFRESH_TTL_SECONDS;
      const refreshToken = signRefreshToken(claims, refreshTtl);
      store.addRefreshToken({ userId: user.id, username: user.username, token: refreshToken, ttlSeconds: refreshTtl, fingerprint: deviceFingerprint(request) });
      await store.persistRefreshTokens();
      await store.setUserLastLogin(user.id);
      await store.recordAudit({ actor: user.username, action: 'login.google', entity: 'user', entityId: user.id }).catch(() => undefined);
      send(result, sessionResponse(request, {
        user: { id: user.id, username: user.username, name: user.displayName, role: roleTitle(user.role), roleId: user.role, permissions: permissionsOf(user.role), organization: organizationName },
        token, refreshToken,
      }, token));
      return;
    }

    if (path === '/api/auth/login' && request.method === 'POST') {
      const input = await readJsonBody<{ username?: string; password?: string; remember?: boolean }>(request, result);
      if (!input) return;
      const username = String(input.username ?? '').trim().toLowerCase();
      const limiter = rateLimit(`login:${username}|${clientKey(request)}`, 8);
      if (!limiter.allowed) {
        await store.recordAudit({ actor: username || 'ناشناس', action: 'login.blocked', entity: 'user', detail: 'تلاش‌های زیاد' }).catch(() => undefined);
        fail(result, `تلاش‌های ورود زیاد بود؛ ${limiter.retryAfter} ثانیه دیگر دوباره تلاش کنید.`, 429);
        return;
      }
      const user = username ? await store.findUser(username) : undefined;
      const passwordOk = Boolean(user && input.password && verifyPassword(input.password, user.passwordHash));
      // ورودِ موفق شمارنده را پاک می‌کند؛ فقط تلاش‌های ناموفق محدود می‌شوند
      if (passwordOk && user?.isActive) rateBuckets.delete(`login:${username}|${clientKey(request)}`);
      if (!user || !passwordOk || !user.isActive) {
        await store.recordAudit({ actor: username || 'ناشناس', action: 'login.failed', entity: 'user', detail: user ? 'رمز نادرست' : 'کاربر ناشناس' }).catch(() => undefined);
        // پیام یکسان برای همه (عدم افشای وجود کاربر) + تأخیر کوتاه
        await new Promise((done) => setTimeout(done, 250));
        fail(result, 'نام کاربری یا رمز عبور صحیح نیست', 401);
        return;
      }
      const claims = { sub: user.id, username: user.username, displayName: user.displayName, role: user.role };
      const token = signToken(claims, ACCESS_TTL_SECONDS);
      // نشست همیشه ۳۰ روزه است؛ «مرا به خاطر بسپار» فقط محلِ نگه‌داری در مرورگر را تعیین می‌کند
      void input.remember;
      const refreshTtl = REFRESH_TTL_SECONDS;
      const refreshToken = signRefreshToken(claims, refreshTtl);
      store.addRefreshToken({ userId: user.id, username: user.username, token: refreshToken, ttlSeconds: refreshTtl, fingerprint: deviceFingerprint(request) });
      await store.persistRefreshTokens();
      await store.setUserLastLogin(user.id);
      await store.recordAudit({ actor: user.username, action: 'login', entity: 'user', entityId: user.id });
      send(result, sessionResponse(request, {
        user: { id: user.id, username: user.username, name: user.displayName, role: roleTitle(user.role), roleId: user.role, permissions: permissionsOf(user.role), organization: organizationName },
        token, refreshToken,
      }, token));
      return;
    }

    if (path === '/api/auth/refresh' && request.method === 'POST') {
      const input = await readJsonBody<{ refreshToken?: string }>(request, result);
      if (!input) return;
      const presented = String(input.refreshToken ?? '');
      const claims = presented ? verifyRefreshToken(presented) : null;
      if (!claims) { fail(result, 'نشست معتبر نیست؛ دوباره وارد شوید', 401, 'AUTH_REQUIRED'); return; }
      const user = await store.findUser(claims.username);
      if (!user || !user.isActive) { fail(result, 'کاربر غیرفعال است', 401); return; }
      const fresh = { sub: user.id, username: user.username, displayName: user.displayName, role: user.role };
      const refreshTtl = REFRESH_TTL_SECONDS;
      /**
       * اثرِ دستگاه (نشانی + مرورگر) کمک می‌کند استفاده‌ی دوباره‌ی «خودِ کاربر» در چند تب،
       * با استفاده‌ی غیرمجازِ یک دستگاهِ دیگر اشتباه گرفته نشود.
       */
      const fingerprint = deviceFingerprint(request);
      const rotation = store.rotateSessionToken({
        presented,
        fingerprint,
        ttlSeconds: refreshTtl,
        issueToken: () => signRefreshToken(fresh, refreshTtl),
      });
      if (rotation.status === 'reuse') {
        await store.persistRefreshTokens();
        await store.recordAudit({ actor: rotation.username ?? claims.username, action: 'refresh_reuse', entity: 'session', detail: 'استفاده‌ی غیرمجاز از توکنِ تازه‌سازی؛ نشست باطل شد' });
        fail(result, 'نشست نامعتبر است؛ دوباره وارد شوید', 401, 'AUTH_REQUIRED');
        return;
      }
      if (rotation.status === 'invalid') {
        /**
         * پایگاهِ داده ممکن است پاک یا بازنشانی شده باشد (میزبانیِ موقت، بازگردانی،
         * جابه‌جایی بینِ چند نمونه). امضای توکن که درست است، یعنی این نشست را خودِ
         * همین کلید صادر کرده: آن را می‌پذیریم و نشست را از نو ثبت می‌کنیم تا کاربر
         * در میانِ کار از برنامه بیرون نیفتد.
         */
        if (claims && claims.username) {
          const restoredToken = signRefreshToken(fresh, refreshTtl);
          store.addRefreshToken({
            token: restoredToken,
            username: claims.username,
            userId: user.id,
            fingerprint,
            ttlSeconds: refreshTtl,
          });
          await store.persistRefreshTokens();
          await store.recordAudit({ actor: claims.username, action: 'session_restored', entity: 'session', detail: 'نشست پس از پاک شدنِ پایگاه داده بازیابی شد' });
          const restoredAccess = signToken(fresh, ACCESS_TTL_SECONDS);
          send(result, sessionResponse(request, {
            user: { id: user.id, username: user.username, name: user.displayName, role: roleTitle(user.role), roleId: user.role, permissions: permissionsOf(user.role), organization: organizationName },
            token: restoredAccess,
            refreshToken: restoredToken,
          }, restoredAccess));
          return;
        }
        fail(result, 'نشست منقضی شده است؛ دوباره وارد شوید', 401, 'AUTH_REQUIRED');
        return;
      }
      await store.persistRefreshTokens();
      const rotatedAccess = signToken(fresh, ACCESS_TTL_SECONDS);
      send(result, sessionResponse(request, {
        user: { id: user.id, username: user.username, name: user.displayName, role: roleTitle(user.role), roleId: user.role, permissions: permissionsOf(user.role), organization: organizationName },
        token: rotatedAccess,
        refreshToken: rotation.token,
      }, rotatedAccess));
      return;
    }

    // خروج: توکن تازه‌سازی در سمت سرور باطل می‌شود
    if (path === '/api/auth/logout' && request.method === 'POST') {
      const input = (await readJsonBody<{ refreshToken?: string; everywhere?: boolean }>(request, result)) ?? {};
      const payload = authenticate(request);
      let revoked = 0;
      if (input.refreshToken) revoked += store.revokeRefreshToken(String(input.refreshToken)) ? 1 : 0;
      if (input.everywhere && payload) revoked += store.revokeUserRefreshTokens(payload.sub);
      await store.persistRefreshTokens();
      if (payload) await store.recordAudit({ actor: payload.username, action: 'logout', entity: 'user', entityId: payload.sub, detail: `${revoked} نشست` });
      send(result, sessionResponse(request, { data: { revoked } }, null));
      return;
    }

    if (path === '/api/me' && request.method === 'GET') {
      const payload = authenticate(request);
      if (!payload) { fail(result, 'نشست شما پایان یافته است؛ لطفاً دوباره وارد شوید.', 401, 'AUTH_REQUIRED'); return; }
      send(result, response({ user: { id: payload.sub, username: payload.username, name: payload.displayName, role: roleTitle(payload.role), roleId: payload.role, permissions: permissionsOf(payload.role), organization: organizationName }, expiresAt: new Date(payload.exp * 1000).toISOString() }));
      return;
    }

    /* --------------------------- شرکت‌ها (چندشرکتی) --------------------------- */

    // شرکت‌هایی که کاربر عضو آن‌هاست
    if (path === '/api/organizations' && request.method === 'GET') {
      // مشاهده‌ی شرکت‌های خودِ کاربر: هر نقشی مجاز است (عضویت محدودکننده است)
      const payload = authorize(request, result, 'events.read');
      if (!payload) return;
      const memberships = await store.listUserMemberships(payload.sub);
      const rows = [];
      for (const membership of memberships) {
        const organization = await store.findOrganization(membership.organizationId);
        if (!organization) continue;
        rows.push({ ...organization, role: membership.role, roleTitle: roleTitle(membership.role), isDefault: membership.isDefault, stats: await store.organizationStats(organization.id) });
      }
      send(result, response({ data: rows, count: rows.length, activeId: resolveOrganization(request, payload) }));
      return;
    }

    // ایجاد شرکت جدید؛ سازنده به‌عنوان مدیر همان شرکت عضو می‌شود
    if (path === '/api/organizations' && request.method === 'POST') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      let input: Parameters<typeof store.createOrganization>[0];
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      try {
        const organization = await store.createOrganization(input);
        await store.addMembership({ userId: payload.sub, organizationId: organization.id, role: 'admin', isDefault: false });
        await store.recordAudit({ actor: payload.username, action: 'organization.create', entity: 'organization', entityId: organization.id, detail: organization.name });
        send(result, response({ ...organization, role: payload.role, roleTitle: roleTitle(payload.role), isDefault: false, stats: await store.organizationStats(organization.id) }, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ایجاد شرکت ناموفق بود'); }
      return;
    }

    // تعیین شرکت پیش‌فرض کاربر
    if (path === '/api/organizations/default' && request.method === 'POST') {
      const payload = authenticate(request);
      if (!payload) { fail(result, 'نشست شما پایان یافته است؛ لطفاً دوباره وارد شوید.', 401, 'AUTH_REQUIRED'); return; }
      let input: { organizationId?: string };
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      const membership = (await store.listUserMemberships(payload.sub)).find((row) => row.organizationId === input.organizationId);
      if (!membership) { fail(result, 'شما عضو این شرکت نیستید', 403); return; }
      await store.setDefaultMembership(payload.sub, membership.organizationId);
      send(result, response({ data: { id: membership.organizationId, name: membership.organizationName, role: membership.role, roleTitle: roleTitle(membership.role) } }));
      return;
    }

    if (path.startsWith('/api/organizations/') && path.endsWith('/members') && request.method === 'GET') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      const id = decodeURIComponent(path.slice('/api/organizations/'.length).replace('/members', ''));
      const memberships = await store.listUserMemberships(payload.sub);
      if (!memberships.some((row) => row.organizationId === id)) { fail(result, 'شما عضو این شرکت نیستید', 403); return; }
      const data = await store.listMemberships(id);
      send(result, response({ data, count: data.length }));
      return;
    }

    if (path.startsWith('/api/organizations/') && path.endsWith('/members') && request.method === 'POST') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      const id = decodeURIComponent(path.slice('/api/organizations/'.length).replace('/members', ''));
      let input: { userId?: string; username?: string; role?: string };
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      const user = input.userId ? (await store.listUsers()).find((row) => row.id === input.userId) : await store.findUser(String(input.username ?? ''));
      if (!user) { fail(result, 'کاربر پیدا نشد'); return; }
      const role = (input.role ?? 'viewer') as Parameters<typeof roleTitle>[0];
      const membership = await store.addMembership({ userId: user.id, organizationId: id, role });
      await store.recordAudit({ actor: payload.username, action: 'organization.member.add', entity: 'organization', entityId: id, detail: `${user.username} با نقش ${roleTitle(role)}` });
      send(result, response(membership, 201));
      return;
    }

    if (path.startsWith('/api/organizations/') && request.method === 'PATCH') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      const id = decodeURIComponent(path.slice('/api/organizations/'.length));
      let input: Parameters<typeof store.updateOrganization>[1];
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      try {
        const organization = await store.updateOrganization(id, input);
        if (!organization) { fail(result, 'شرکت پیدا نشد', 404); return; }
        send(result, response(organization));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'به‌روزرسانی شرکت ناموفق بود'); }
      return;
    }


    /* ------------------------ پشتیبان‌گیری و بازگردانی ------------------------ */

    // دانلود نسخه‌ی کامل از همه‌ی شرکت‌ها و داده‌ها
    /** فهرست و دریافتِ نسخه‌های پشتیبانِ خودکار */
    if (path === '/api/backup/list' && request.method === 'GET') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      send(result, response(listBackups()));
      return;
    }

    if (path === '/api/backup/now' && request.method === 'POST') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      const file = takeBackup();
      if (!file) { fail(result, 'ساختِ نسخه‌ی پشتیبان ناموفق بود.'); return; }
      await store.recordAudit({ actor: payload.username, action: 'backup.auto', entity: 'backup', detail: file }).catch(() => undefined);
      send(result, response({ file, backups: listBackups() }));
      return;
    }

    if (path.startsWith('/api/backup/file/') && request.method === 'GET') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      try {
        const fileName = decodeURIComponent(path.replace('/api/backup/file/', ''));
        const filePath = backupPath(fileName);
        if (!existsSync(filePath)) { fail(result, 'نسخه‌ی پشتیبان پیدا نشد.', 404); return; }
        const content = readFileSync(filePath);
        send(result, {
          status: 200,
          body: content,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${fileName}"`,
          },
        });
      } catch {
        fail(result, 'دریافتِ نسخه‌ی پشتیبان ممکن نیست.');
      }
      return;
    }

    if (path === '/api/backup' && request.method === 'GET') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      const snapshot = store.exportSnapshot();
      const stamp = new Date().toISOString().slice(0, 10);
      result.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="aria-backup-${stamp}.json"`,
      });
      result.end(JSON.stringify(snapshot, null, 2));
      await store.recordAudit({ actor: payload.username, action: 'backup.export', entity: 'backup', detail: `${snapshot.organizations.length} شرکت` });
      return;
    }

    // بازگردانی نسخه‌ی پشتیبان
    if (path === '/api/backup/restore' && request.method === 'POST') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      let snapshot: Parameters<typeof store.importSnapshot>[0];
      try { snapshot = JSON.parse(await readBody(request)) as typeof snapshot; } catch { fail(result, 'فایل پشتیبان قابل خواندن نیست'); return; }
      try {
        const summary = await store.importSnapshot(snapshot);
        await store.recordAudit({ actor: payload.username, action: 'backup.restore', entity: 'backup', detail: `${summary.journals} سند، ${summary.organizations} شرکت` });
        send(result, response({ data: summary }));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'بازگردانی ناموفق بود'); }
      return;
    }


    /* ------------------------------ فضای کاری ------------------------------ */

    /**
     * فضای کاریِ شرکت: داده‌های ماژول‌ها (فاکتور، سفارش، کالا، کارمند، سرنخ، بودجه، …).
     * پیش‌تر این داده‌ها فقط در حافظه‌ی مرورگر می‌ماند و با پاک شدنِ مرورگر از بین می‌رفت؛
     * اکنون نسخه‌ی مرجع روی سرور نگه داشته می‌شود و هر تغییرِ کاربر بلافاصله اینجا ذخیره می‌گردد.
     */
    if (path === '/api/workspace' && request.method === 'GET') {
      const payload = authorize(request, result, 'events.read');
      if (!payload) return;
      const organizationId = resolveOrganization(request, payload);
      const workspace = await store.getWorkspace(organizationId);
      send(result, response({ organizationId, entries: workspace?.entries ?? {}, updatedAt: workspace?.updatedAt ?? null }));
      return;
    }
    if (path === '/api/workspace' && (request.method === 'PUT' || request.method === 'POST')) {
      const payload = authorize(request, result, 'events.write');
      if (!payload) return;
      const input = await readJsonBody<{ entries?: Record<string, unknown> }>(request, result);
      if (!input) return;
      const entries = input.entries && typeof input.entries === 'object' && !Array.isArray(input.entries) ? input.entries : null;
      if (!entries) { fail(result, 'ساختارِ داده‌ی فضای کاری معتبر نیست'); return; }
      const allowed = Object.fromEntries(Object.entries(entries).filter(([key]) => /^erp-[a-z-]{2,40}$/.test(key)));
      if (!Object.keys(allowed).length) { fail(result, 'هیچ کلیدِ معتبری برای ذخیره فرستاده نشده است'); return; }
      try {
        const saved = await store.saveWorkspaceEntries(resolveOrganization(request, payload), allowed, payload.username);
        send(result, response({ ok: true, updatedAt: saved.updatedAt, keys: Object.keys(allowed) }));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ذخیره‌ی فضای کاری ناموفق بود'); }
      return;
    }

    /* ------------------------------ رویدادها ------------------------------ */

    if (path === '/api/events' && request.method === 'GET') {
      const payload = authorize(request, result, 'events.read');
      if (!payload) return;
      const data = usingDatabase ? await listEventsFromDatabase().catch(() => []) : await store.listEvents(resolveOrganization(request, payload));
      send(result, response({ data, count: data.length }));
      return;
    }

    if (path === '/api/events' && request.method === 'POST') {
      const payload = authorize(request, result, 'events.write');
      if (!payload) return;
      let input: store.CreateEventInput;
      try { input = JSON.parse(await readBody(request)) as store.CreateEventInput; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      try {
        const event = await store.addEvent({ ...input, createdBy: payload.username, organizationId: resolveOrganization(request, payload) });
        if (usingDatabase) await insertEvent({ module: event.moduleId, eventType: 'record.created', title: event.title, amount: String(event.amount), status: event.status, owner: event.createdBy }).catch(() => undefined);
        await store.recordAudit({ actor: payload.username, action: 'event.create', entity: 'event', entityId: event.id, detail: event.title });
        send(result, response(event, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت رویداد ناموفق بود'); }
      return;
    }

    if (path === '/api/events' && request.method === 'DELETE') {
      const payload = authorize(request, result, 'events.write');
      if (!payload) return;
      const id = url.searchParams.get('id');
      if (!id) { fail(result, 'شناسه رویداد الزامی است'); return; }
      await store.patchEvent(id, { status: 'حذف‌شده' });
      await store.recordAudit({ actor: payload.username, action: 'event.delete', entity: 'event', entityId: id });
      send(result, response({ ok: true }));
      return;
    }

    /* --------------------- ردیابی عملیات، آمار و شماره‌گذاری --------------------- */

    if (path === '/api/audit' && request.method === 'GET') {
      const payload = authorize(request, result, 'audit.read');
      if (!payload) return;
      const data = await store.listAudit(Number(url.searchParams.get('limit') ?? 200) || 200);
      send(result, response({ data, count: data.length }));
      return;
    }

    if (path === '/api/stats' && request.method === 'GET') {
      const payload = authorize(request, result, 'audit.read');
      if (!payload) return;
      send(result, response(await store.stats()));
      return;
    }

    if (path === '/api/numbering' && request.method === 'GET') {
      if (!authorize(request, result, 'events.read')) return;
      send(result, response({ data: await store.listCounters() }));
      return;
    }

    if (path.startsWith('/api/numbering/') && request.method === 'POST') {
      const payload = authorize(request, result, 'events.write');
      if (!payload) return;
      const key = path.split('/').pop() ?? 'document';
      const number = await store.nextNumber(key, 1000, resolveOrganization(request, payload));
      await store.recordAudit({ actor: payload.username, action: 'numbering.reserve', entity: key, detail: String(number) });
      send(result, response({ key, number }, 201));
      return;
    }

    /* ---------------------- سال مالی و مراکز هزینه ---------------------- */

    if (path === '/api/fiscal-periods' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      const data = await store.listPeriods(resolveOrganization(request, payload));
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/fiscal-periods' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof store.createPeriod>[0];
        const period = await store.createPeriod({ ...input, organizationId: resolveOrganization(request, payload) });
        await store.recordAudit({ actor: payload.username, action: 'period.create', entity: 'fiscal-period', entityId: period.id, detail: period.title });
        send(result, response(period, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ایجاد دوره ناموفق بود'); }
      return;
    }
    if (path.startsWith('/api/fiscal-periods/') && request.method === 'PATCH') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as { status?: 'باز' | 'بسته' };
        const period = await store.setPeriodStatus(path.split('/').pop() ?? '', input.status === 'بسته' ? 'بسته' : 'باز');
        if (!period) { fail(result, 'دوره پیدا نشد', 404); return; }
        await store.recordAudit({ actor: payload.username, action: input.status === 'بسته' ? 'period.close' : 'period.open', entity: 'fiscal-period', entityId: period.id, detail: period.title });
        send(result, response(period));
      } catch { fail(result, 'تغییر وضعیت دوره ناموفق بود'); }
      return;
    }
    /* ---------------------- بستنِ سال مالی ---------------------- */
    if (path === '/api/fiscal-periods/close-year' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as { year?: number };
        const year = Number(input.year ?? 0);
        if (!year) { fail(result, 'سال مالی مشخص نشده است.'); return; }
        const closing = await store.closeFiscalYear({ organizationId: resolveOrganization(request, payload), year, actor: payload.username });
        await store.recordAudit({ actor: payload.username, action: 'fiscal-year.close', entity: 'period', detail: `سال ${year} — سند ${closing.number}` }).catch(() => undefined);
        send(result, response(closing));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'بستنِ سال مالی ناموفق بود'); }
      return;
    }

    /* ---------------------- اسناد تکرارشونده ---------------------- */
    if (path === '/api/accounting/recurring' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      send(result, response(await store.listRecurring(resolveOrganization(request, payload))));
      return;
    }
    if (path === '/api/accounting/recurring' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof store.createRecurring>[0];
        const record = await store.createRecurring({ ...input, organizationId: resolveOrganization(request, payload) });
        await store.recordAudit({ actor: payload.username, action: 'recurring.create', entity: 'recurring', entityId: record.id, detail: record.title }).catch(() => undefined);
        send(result, response(record, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'تعریفِ سند تکرارشونده ناموفق بود'); }
      return;
    }
    if (path.startsWith('/api/accounting/recurring/') && path.endsWith('/run') && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const id = path.split('/')[4] ?? '';
        const output = await store.runRecurring(id, true, payload.username);
        await store.recordAudit({ actor: payload.username, action: 'recurring.run', entity: 'recurring', entityId: id, detail: output.title }).catch(() => undefined);
        send(result, response(output));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'صدورِ سند تکرارشونده ناموفق بود'); }
      return;
    }
    if (path.startsWith('/api/accounting/recurring/') && path.endsWith('/toggle') && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      const record = await store.toggleRecurring(path.split('/')[4] ?? '');
      if (!record) { fail(result, 'الگوی سند پیدا نشد.', 404); return; }
      send(result, response(record));
      return;
    }
    if (path.startsWith('/api/accounting/recurring/') && request.method === 'DELETE') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      await store.deleteRecurring(path.split('/')[4] ?? '');
      send(result, response({ deleted: true }));
      return;
    }

    if (path === '/api/cost-centers' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      const data = await store.listCostCenters(resolveOrganization(request, payload));
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/cost-centers' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as { code: string; title: string };
        const center = await store.createCostCenter({ ...input, organizationId: resolveOrganization(request, payload) });
        await store.recordAudit({ actor: payload.username, action: 'cost-center.create', entity: 'cost-center', entityId: center.id, detail: `${center.code} - ${center.title}` });
        send(result, response(center, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ایجاد مرکز هزینه ناموفق بود'); }
      return;
    }

    /* -------------------------- اسناد و گردش کار -------------------------- */

    if (path === '/api/documents' && request.method === 'GET') {
      const viewer = authorize(request, result, 'events.read');
      if (!viewer) return;
      const all = await store.listDocuments({ moduleId: url.searchParams.get('moduleId') ?? undefined, status: url.searchParams.get('status') ?? undefined, organizationId: resolveOrganization(request, viewer) });
      // هر کاربر فقط اسناد ماژول‌هایی را می‌بیند که مجوز خواندن یا نوشتن آن را دارد
      const grants = permissionsOf(viewer.role);
      const data = all.filter((item) => viewer.role === 'admin' || grants.includes(`${item.moduleId}.read` as Permission) || grants.includes(`${item.moduleId}.write` as Permission));
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/documents' && request.method === 'POST') {
      const payload = authorize(request, result, 'events.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as store.CreateDocumentInput;
        const document = await store.createDocument({ ...input, createdBy: payload.username, organizationId: resolveOrganization(request, payload) });
        await store.recordAudit({ actor: payload.username, action: 'document.create', entity: 'document', entityId: document.id, detail: `${document.number} - ${document.title}` });
        send(result, response(document, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ایجاد سند ناموفق بود'); }
      return;
    }
    if (path === '/api/documents/transitions' && request.method === 'GET') {
      if (!authorize(request, result, 'events.read')) return;
      send(result, response({ data: workflowTransitions }));
      return;
    }
    if (path.startsWith('/api/documents/') && path.endsWith('/transitions') && request.method === 'POST') {
      const id = path.split('/')[3] ?? '';
      const document = await store.getDocument(id);
      if (!document) { fail(result, 'سند پیدا نشد', 404); return; }
      let input: { action?: string; comment?: string };
      try { input = JSON.parse(await readBody(request)) as { action?: string; comment?: string }; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      const status = document.status as WorkflowStatus;
      const transition = findTransition(status, input.action ?? '');
      if (!transition) { fail(result, `انتقال «${input.action ?? ''}» از وضعیت «${status}» مجاز نیست`, 409); return; }
      const payload = authorize(request, result, transition.permission);
      if (!payload) return;
      const updated = await store.transitionDocument(id, { action: transition.action, to: transition.to, actor: payload.username, comment: input.comment });
      await store.recordAudit({ actor: payload.username, action: `document.${transition.action}`, entity: 'document', entityId: id, detail: `${status} ← ${transition.to}${input.comment ? ` (${input.comment})` : ''}` });
      // صدور خودکار سند حسابداری هنگام قطعی‌شدن سند
      let journal: Awaited<ReturnType<typeof store.createJournalEntry>> | undefined;
      if (transition.action === 'post' && updated) {
        const sourceType = sourceByModule[updated.moduleId];
        if (sourceType && updated.amount > 0) {
          const taxable = sourceType === 'sales' || sourceType === 'purchase';
          const draft = buildJournal({
            sourceType,
            amount: updated.amount,
            tax: taxable ? vatOf(updated.amount) : 0,
            description: updated.title,
            costCenter: updated.costCenterId,
          });
          journal = await store.createJournalEntry({
            organizationId: resolveOrganization(request, payload),
            sourceType: draft.sourceType,
            description: `${draft.description} — سند ${updated.number}`,
            lines: draft.lines,
            sourceId: updated.id,
            moduleId: updated.moduleId,
            periodId: updated.periodId,
            costCenterId: updated.costCenterId,
            createdBy: payload.username,
            status: 'قطعی',
          });
          await store.recordAudit({ actor: payload.username, action: 'journal.auto-post', entity: 'journal', entityId: journal.id, detail: `${journal.number} برای سند ${updated.number}` });
        }
      }
      send(result, response({ ...updated, journal: journal ? { id: journal.id, number: journal.number, totalDebit: journal.totalDebit, totalCredit: journal.totalCredit } : null }));
      return;
    }
    if (path.startsWith('/api/documents/') && request.method === 'GET') {
      if (!authorize(request, result, 'events.read')) return;
      const document = await store.getDocument(path.split('/').pop() ?? '');
      if (!document) { fail(result, 'سند پیدا نشد', 404); return; }
      send(result, response(document));
      return;
    }

    /* -------------------------------- حسابداری -------------------------------- */

    if (path === '/api/accounting/journals' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof createJournal>[0] & { sourceType?: string; sourceId?: string; moduleId?: string };
        // در صورت تنظیم DATABASE_URL از Postgres و در غیر این صورت از پایگاه فایلی استفاده می‌شود
        const journal = process.env.DATABASE_URL
          ? await createJournal(input)
          : await store.createJournalEntry({
            organizationId: resolveOrganization(request, payload),
              sourceType: input.sourceType ?? 'manual',
              description: input.description ?? '',
              lines: input.lines ?? [],
              sourceId: input.sourceId,
              moduleId: input.moduleId,
              createdBy: payload.username,
            });
        await store.recordAudit({ actor: payload.username, action: 'journal.create', entity: 'journal', detail: input.description });
        send(result, response(journal, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت سند ناموفق بود'); }
      return;
    }
    if (path === '/api/accounting/entries' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      const data = await store.listJournalEntries({ status: url.searchParams.get('status') ?? undefined, moduleId: url.searchParams.get('moduleId') ?? undefined, organizationId: resolveOrganization(request, payload) });
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/accounting/entries' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as { sourceType?: string; amount?: number; tax?: number; description?: string; costCenterId?: string; periodId?: string; sourceId?: string; moduleId?: string; status?: 'پیش‌نویس' | 'قطعی' };
        if (!isPostingSource(input.sourceType)) { fail(result, 'نوع عملیات مالی معتبر نیست'); return; }
        const draft = buildJournal({ sourceType: input.sourceType, amount: Number(input.amount ?? 0), tax: Number(input.tax ?? 0), description: input.description, costCenter: input.costCenterId });
        const entry = await store.createJournalEntry({
          organizationId: resolveOrganization(request, payload),
          sourceType: draft.sourceType,
          description: draft.description,
          lines: draft.lines,
          sourceId: input.sourceId,
          moduleId: input.moduleId,
          periodId: input.periodId,
          costCenterId: input.costCenterId,
          createdBy: payload.username,
          status: input.status,
        });
        await store.recordAudit({ actor: payload.username, action: 'journal.create', entity: 'journal', entityId: entry.id, detail: `${entry.number} - ${entry.description}` });
        send(result, response(entry, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'صدور سند ناموفق بود'); }
      return;
    }
    if (path.startsWith('/api/accounting/entries/') && path.endsWith('/post') && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      const entry = await store.postJournalEntry(path.split('/')[4] ?? '', payload.username);
      if (!entry) { fail(result, 'سند پیدا نشد', 404); return; }
      await store.recordAudit({ actor: payload.username, action: 'journal.post', entity: 'journal', entityId: entry.id, detail: String(entry.number) });
      send(result, response(entry));
      return;
    }
    if (path === '/api/accounting/trial-balance' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      const data = await store.accountBalances(resolveOrganization(request, payload));
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/accounting/summary' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      send(result, response(await store.financialSummary(resolveOrganization(request, payload))));
      return;
    }
    if (path === '/api/accounting/balance-sheet' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      send(result, response(await store.balanceSheetReport({ from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined })));
      return;
    }
    if (path === '/api/accounting/profit-loss' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      send(result, response(await store.profitLossReport({ from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined })));
      return;
    }
    if (path === '/api/accounting/general-ledger' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      send(result, response(await store.generalLedgerReport({ from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined })));
      return;
    }
    if (path === '/api/accounting/subsidiary' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      const accountCode = url.searchParams.get('account') ?? '';
      if (!accountCode) { fail(result, 'کد حساب الزامی است', 400); return; }
      send(result, response(await store.subsidiaryLedgerReport(accountCode, { from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined })));
      return;
    }
    if (path === '/api/accounting/vat' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      send(result, response(await store.vatReport({ from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined })));
      return;
    }
    if (path === '/api/inventory/movements' && request.method === 'GET') {
      const payload = authorize(request, result, 'inventory.read');
      if (!payload) return;
      send(result, response(await store.listStockMovements(url.searchParams.get('itemId') ?? undefined, resolveOrganization(request, payload))));
      return;
    }
    if (path === '/api/inventory/movements' && request.method === 'POST') {
      const payload = authorize(request, result, 'inventory.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof store.createStockMovement>[0];
        const movement = await store.createStockMovement({ ...input, organizationId: resolveOrganization(request, payload) });
        await store.recordAudit({ actor: payload.username, action: 'stock.move', entity: 'stock', entityId: movement.id, detail: `${movement.type} ${movement.quantity} × ${movement.itemTitle}` });
        send(result, response(movement, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت حرکت انبار ناموفق بود'); }
      return;
    }
    if (path === '/api/inventory/serials' && request.method === 'GET') {
      const payload = authorize(request, result, 'inventory.read');
      if (!payload) return;
      const url = new URL(request.url ?? '/', 'http://localhost');
      const status = (url.searchParams.get('status') ?? '') as SerialStatus | '';
      const data = await listSerials({
        itemId: url.searchParams.get('itemId') ?? undefined,
        status: status || undefined,
}).catch(() => []);
      send(result, response({ data, count: data.length, summary: await serialsSummary().catch(() => ({ total: 0, byStatus: {} })) }));
      return;
    }

    if (path === '/api/inventory/serials' && request.method === 'POST') {
      const payload = authorize(request, result, 'inventory.write');
      if (!payload) return;
      let input: Parameters<typeof createSerials>[0];
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      try {
        const created = await createSerials({ ...input, organizationId: resolveOrganization(request, payload) });
        await store.recordAudit({ actor: payload.username, action: 'serial.create', entity: 'serial', detail: `${created.created.length} سریال برای ${input.itemTitle}` });
        send(result, response(created, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت سریال ناموفق بود'); }
      return;
    }

    if (path === '/api/inventory/serials/status' && request.method === 'POST') {
      const payload = authorize(request, result, 'inventory.write');
      if (!payload) return;
      let input: Parameters<typeof updateSerialStatus>[0];
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      try {
        const updated = await updateSerialStatus(input);
        await store.recordAudit({ actor: payload.username, action: 'serial.status', entity: 'serial', detail: `${updated.length} سریال → ${input.status}` });
        send(result, response({ updated, count: updated.length }));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'تغییر وضعیت سریال ناموفق بود'); }
      return;
    }

    if (path === '/api/inventory/costing' && request.method === 'GET') {
      const payload = authorize(request, result, 'inventory.read');
      if (!payload) return;
      send(result, response(await store.inventoryCosting(url.searchParams.get('method') === 'fifo' ? 'fifo' : 'wac')));
      return;
    }
    if (path === '/api/treasury/statements' && request.method === 'GET') {
      const payload = authorize(request, result, 'treasury.read');
      if (!payload) return;
      send(result, response(await store.listBankStatements()));
      return;
    }
    if (path === '/api/treasury/statements' && request.method === 'POST') {
      const payload = authorize(request, result, 'treasury.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof store.createBankStatement>[0];
        const statement = await store.createBankStatement(input);
        await store.recordAudit({ actor: payload.username, action: 'bank.statement', entity: 'bank', entityId: statement.id, detail: `${statement.direction} ${statement.amount}` });
        send(result, response(statement, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت صورت‌حساب ناموفق بود'); }
      return;
    }
    if (path === '/api/treasury/reconciliation' && request.method === 'GET') {
      const payload = authorize(request, result, 'treasury.read');
      if (!payload) return;
      send(result, response(await store.bankReconciliation()));
      return;
    }
    if (path === '/api/payroll/calculate' && request.method === 'POST') {
      const payload = authorize(request, result, 'payroll.read');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof store.calculatePayrollFor>[0];
        send(result, response(await store.calculatePayrollFor(input)));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'محاسبه ناموفق بود'); }
      return;
    }
    if (path === '/api/payroll/records' && request.method === 'GET') {
      const payload = authorize(request, result, 'payroll.read');
      if (!payload) return;
      send(result, response(await store.listPayrollRecords(url.searchParams.get('period') ?? undefined, resolveOrganization(request, payload))));
      return;
    }
    if (path === '/api/payroll/records' && request.method === 'POST') {
      const payload = authorize(request, result, 'payroll.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as { period: string; personnelCode: string; fullName: string; payroll: Parameters<typeof store.calculatePayrollFor>[0]; postJournal?: boolean };
        let journalId: string | undefined;
        if (input.postJournal) {
          const payrollGross = calculatePayroll(input.payroll).gross;
          const draft = buildJournal({ sourceType: 'payroll', amount: payrollGross, description: `حقوق و دستمزد ${input.period} — ${input.fullName}` });
          const entry = await store.createJournalEntry({
            organizationId: resolveOrganization(request, payload), sourceType: draft.sourceType, description: draft.description, lines: draft.lines, status: 'قطعی' });
          journalId = entry.id;
        }
        const record = await store.createPayrollRecord({
          organizationId: resolveOrganization(request, payload), period: input.period, personnelCode: input.personnelCode, fullName: input.fullName, payroll: input.payroll, journalId, createdBy: payload.username });
        await store.recordAudit({ actor: payload.username, action: 'payroll.create', entity: 'payroll', entityId: record.id, detail: `${input.period} - ${record.fullName}` });
        send(result, response(record, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت حقوق ناموفق بود'); }
      return;
    }
    if (path === '/api/payroll/summary' && request.method === 'GET') {
      const payload = authorize(request, result, 'payroll.read');
      if (!payload) return;
      send(result, response(await store.payrollSummary(url.searchParams.get('period') ?? undefined)));
      return;
    }
    if (path === '/api/treasury/checks' && request.method === 'GET') {
      const payload = authorize(request, result, 'treasury.read');
      if (!payload) return;
      send(result, response(await store.listChecks({ direction: url.searchParams.get('direction') ?? undefined, status: url.searchParams.get('status') ?? undefined, organizationId: resolveOrganization(request, payload) })));
      return;
    }
    if (path === '/api/treasury/checks' && request.method === 'POST') {
      const payload = authorize(request, result, 'treasury.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof store.createCheck>[0];
        const check = await store.createCheck({ ...input, createdBy: payload.username, organizationId: resolveOrganization(request, payload) });
        await store.recordAudit({ actor: payload.username, action: 'check.create', entity: 'check', entityId: check.id, detail: `${check.number} - ${check.amount}` });
        send(result, response(check, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت چک ناموفق بود'); }
      return;
    }
    if (path === '/api/treasury/checks/summary' && request.method === 'GET') {
      if (!authorize(request, result, 'treasury.read')) return;
      send(result, response(await store.checksSummary()));
      return;
    }
    if (path.startsWith('/api/treasury/checks/') && request.method === 'POST') {
      const payload = authorize(request, result, 'treasury.write');
      if (!payload) return;
      try {
        const id = path.replace('/api/treasury/checks/', '');
        const input = JSON.parse(await readBody(request)) as { status: string };
        const check = await store.updateCheckStatus(id, input.status as Parameters<typeof store.updateCheckStatus>[1]);
        if (!check) { fail(result, 'چک پیدا نشد', 404); return; }
        await store.recordAudit({ actor: payload.username, action: 'check.status', entity: 'check', entityId: id, detail: input.status });
        send(result, response(check));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'تغییر وضعیت ناموفق بود'); }
      return;
    }
    if (path === '/api/budget/analysis' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      let input: { lines?: BudgetLineInput[]; warningThreshold?: number; criticalThreshold?: number; fromAccounts?: boolean };
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      const lines = Array.isArray(input.lines) ? input.lines : [];
      if (!lines.length) { fail(result, 'هیچ ردیف بودجه‌ای ارسال نشده است'); return; }
      // در صورت درخواست، عملکرد واقعی از مانده‌ی حساب‌های دفتر کل خوانده می‌شود
      const effective = input.fromAccounts ? applyActualFromAccounts(lines, await store.accountBalances().catch(() => [])) : lines;
      send(result, response(analyzeBudget(effective, { warningThreshold: input.warningThreshold, criticalThreshold: input.criticalThreshold })));
      return;
    }

    if (path === '/api/reports/sources' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      send(result, response({ data: REPORT_SOURCES, count: REPORT_SOURCES.length }));
      return;
    }

    if (path === '/api/reports/run' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      let definition: ReportDefinition;
      try { definition = JSON.parse(await readBody(request)) as ReportDefinition; } catch { fail(result, 'تعریف گزارش معتبر نیست'); return; }
      try { send(result, response(await runReport(definition))); }
      catch (error) { fail(result, error instanceof Error ? error.message : 'اجرای گزارش ناموفق بود'); }
      return;
    }

    if (path === '/api/insights/summary' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      const [sheet, income, trial, documents, payroll, checks] = await Promise.all([
        store.balanceSheetReport({}),
        store.profitLossReport({}),
        store.accountBalances(),
        store.listDocuments(),
        store.payrollSummary(),
        store.checksSummary(),
      ]);
      // مانده‌ی بدهکار برای دارایی‌ها و بستانکار برای بدهی‌ها (قدر مطلق)
      const balanceOf = (code: string, creditNature = false): number => {
        const row = trial.find((item) => item.code === code);
        if (!row) return 0;
        const value = creditNature ? row.credit - row.debit : row.debit - row.credit;
        return Math.round(value * 100) / 100;
      };
      send(result, response({
        finance: {
          assets: sheet.totalAssets,
          liabilities: sheet.totalLiabilities,
          equity: sheet.totalEquity,
          netIncome: income.netIncome,
          revenue: income.totalRevenue,
          expense: income.totalExpense,
          cash: balanceOf('1100'),
          receivables: balanceOf('1200'),
          inventory: balanceOf('1300'),
          payables: balanceOf('2000', true),
        },
        operations: {
          documents: documents.length,
          posted: documents.filter((item) => item.status === 'قطعی').length,
          pending: documents.filter((item) => item.status !== 'قطعی' && item.status !== 'ردشده').length,
          rejected: documents.filter((item) => item.status === 'ردشده').length,
        },
        payroll,
        checks,
      }));
      return;
    }
    if (path === '/api/treasury/reconciliation' && request.method === 'POST') {
      const payload = authorize(request, result, 'treasury.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as { statementId: string; entryId: string | null };
        if (!input.statementId) { fail(result, 'شناسه‌ی ردیف صورت‌حساب الزامی است', 400); return; }
        const row = await store.matchBankStatement(input.statementId, input.entryId ?? null);
        if (!row) { fail(result, 'ردیف صورت‌حساب پیدا نشد', 404); return; }
        await store.recordAudit({ actor: payload.username, action: 'bank.match', entity: 'bank', entityId: row.id, detail: input.entryId ? 'تطبیق با سند' : 'لغو تطبیق' });
        send(result, response(row));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'تطبیق ناموفق بود'); }
      return;
    }
    if (path === '/api/accounting/balances' && request.method === 'GET') { send(result, response({ data: await listAccountBalances().catch(() => []), count: 0 })); return; }
    if (path === '/api/accounting/accounts' && request.method === 'GET') { const data = await listAccounts().catch(() => []); send(result, response({ data, count: data.length })); return; }
    if (path === '/api/accounting/accounts' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as { code?: string; title?: string };
        const account = await createAccount(input.code ?? '', input.title ?? '');
        await store.recordAudit({ actor: payload.username, action: 'account.create', entity: 'account', detail: `${input.code} - ${input.title}` });
        send(result, response(account, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ساخت حساب ناموفق بود'); }
      return;
    }
    if (path.startsWith('/api/accounting/accounts/') && request.method === 'DELETE') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try { await deleteAccount(path.split('/').pop() ?? ''); send(result, response({ ok: true })); }
      catch { fail(result, 'حساب استفاده‌شده قابل حذف نیست'); }
      return;
    }

    /* ------------------------------ خزانه‌داری ------------------------------ */

    if (path === '/api/treasury' && request.method === 'GET') {
      const payload = authorize(request, result, 'treasury.read');
      if (!payload) return;
      const data = usingDatabase ? await listTreasury().catch(() => []) : await store.listTreasuryTransactions(resolveOrganization(request, payload)).catch(() => []);
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/treasury' && request.method === 'POST') {
      const payload = authorize(request, result, 'treasury.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof createTreasury>[0];
        const transaction = usingDatabase
          ? await createTreasury(input)
          : await store.createTreasuryTransaction({ ...input, organizationId: resolveOrganization(request, payload), createdBy: payload.username });
        await store.recordAudit({ actor: payload.username, action: 'treasury.create', entity: 'treasury', detail: input.description });
        send(result, response(transaction, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت تراکنش ناموفق بود'); }
      return;
    }

    /* --------------------------------- فروش --------------------------------- */

    if (path === '/api/sales/invoices' && request.method === 'GET') {
      const payload = authorize(request, result, 'sales.read');
      if (!payload) return;
      const data = usingDatabase ? await listSalesInvoices().catch(() => []) : await store.listSalesInvoices(resolveOrganization(request, payload)).catch(() => []);
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/sales/invoices' && request.method === 'POST') {
      const payload = authorize(request, result, 'sales.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof createSalesInvoice>[0];
        const invoice = usingDatabase
          ? await createSalesInvoice(input)
          : await store.createSalesInvoiceRecord({ ...input, organizationId: resolveOrganization(request, payload), createdBy: payload.username });
        await store.recordAudit({ actor: payload.username, action: 'invoice.create', entity: 'sales-invoice', detail: input.customerName });
        // ورودِ خودکارِ صورت‌حساب به صفِ سامانه‌ی مؤدیان (بهترین تلاش؛ خطایش مانعِ ثبتِ فاکتور نمی‌شود)
        try {
          const lines = Array.isArray((invoice as { lines?: unknown[] }).lines) ? (invoice as { lines: Array<{ itemTitle: string; quantity: number; unitPrice: number }> }).lines : [];
          const subtotal = Number((invoice as { subtotal?: number }).subtotal ?? lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0));
          const vat = Number((invoice as { tax?: number }).tax ?? 0);
          const built = buildTaxInvoicePayload({
            invoiceNumber: String((invoice as { invoiceNumber?: number | string }).invoiceNumber ?? ''),
            buyerName: input.customerName,
            lines,
            discount: Number((invoice as { discount?: number }).discount ?? 0),
            vatRate: subtotal > 0 ? Math.round((vat / subtotal) * 1000) / 10 : 10,
          });
          await store.createTaxSubmission({
            organizationId: resolveOrganization(request, payload),
            invoiceNumber: String((invoice as { invoiceNumber?: number | string }).invoiceNumber ?? ''),
            invoiceType: 'فروش',
            buyerName: input.customerName,
            totalBeforeVat: subtotal,
            totalVat: vat,
            totalAmount: subtotal + vat,
            payload: JSON.stringify(built),
            createdBy: payload.username,
          });
        } catch { /* ثبتِ فاکتور موفق بود؛ صف بعداً پر می‌شود */ }
        send(result, response(invoice, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت فاکتور ناموفق بود'); }
      return;
    }

    /* ------------------------- سامانه‌ی مؤدیان (مالیات) ------------------------- */

    if (path === '/api/tax/settings' && request.method === 'GET') {
      const payload = authorize(request, result, 'sales.read');
      if (!payload) return;
      const settings = taxSettings();
      send(result, response({
        configured: settings.configured,
        endpoint: settings.endpoint ?? '',
        fiscalId: settings.fiscalId ?? '',
        nationalId: settings.nationalId ?? '',
        missing: settings.missing,
      }));
      return;
    }

    if (path === '/api/tax/submissions' && request.method === 'GET') {
      const payload = authorize(request, result, 'sales.read');
      if (!payload) return;
      const data = await store.listTaxSubmissions(resolveOrganization(request, payload));
      send(result, response({ data, count: data.length, configured: taxSettings().configured }));
      return;
    }

    if (path === '/api/tax/submissions' && request.method === 'POST') {
      const payload = authorize(request, result, 'sales.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as {
          invoiceNumber: string; invoiceType?: string; buyerName: string; buyerNationalId?: string;
          lines: Array<{ itemTitle: string; quantity: number; unitPrice: number }>; discount?: number; vatRate?: number;
        };
        if (!input.invoiceNumber?.trim() || !input.buyerName?.trim()) throw new Error('شماره و خریدارِ صورت‌حساب الزامی است');
        const built = buildTaxInvoicePayload({ ...input, lines: input.lines ?? [] });
        const totals = built.invoice as { totalBeforeVat: number; totalVat: number; totalAmount: number };
        const record = await store.createTaxSubmission({
          organizationId: resolveOrganization(request, payload),
          invoiceNumber: input.invoiceNumber.trim(),
          invoiceType: input.invoiceType ?? 'فروش',
          buyerName: input.buyerName.trim(),
          buyerNationalId: input.buyerNationalId,
          totalBeforeVat: totals.totalBeforeVat,
          totalVat: totals.totalVat,
          totalAmount: totals.totalAmount,
          payload: JSON.stringify(built),
          createdBy: payload.username,
        });
        await store.recordAudit({ actor: payload.username, action: 'tax.queue', entity: 'tax-submission', detail: input.invoiceNumber });
        send(result, response(record, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت در صف ناموفق بود'); }
      return;
    }

    if (path === '/api/tax/submissions/send-all' && request.method === 'POST') {
      const payload = authorize(request, result, 'sales.write');
      if (!payload) return;
      const organizationId = resolveOrganization(request, payload);
      if (!taxSettings().configured) { fail(result, 'تنظیماتِ اتصالِ سامانه‌ی مؤدیان کامل نیست؛ متغیرهای TAX_* را در فایل .env پر کنید', 400); return; }
      const queue = (await store.listTaxSubmissions(organizationId)).filter((row) => row.status !== 'ارسال شد').slice(0, 25);
      let sent = 0; let failed = 0;
      for (const row of queue) {
        const outcome = await sendInvoiceToTaxSystem(JSON.parse(row.payload));
        if (outcome.ok) {
          await store.updateTaxSubmission(row.id, { status: 'ارسال شد', attempts: row.attempts + 1, referenceId: outcome.referenceId, lastError: undefined, sentAt: new Date().toISOString() });
          sent += 1;
        } else {
          await store.updateTaxSubmission(row.id, { status: 'ناموفق', attempts: row.attempts + 1, lastError: outcome.error });
          failed += 1;
        }
      }
      send(result, response({ sent, failed, total: queue.length }));
      return;
    }

    const taxSendMatch = /^\/api\/tax\/submissions\/([\w-]+)\/send$/.exec(path);
    if (taxSendMatch && request.method === 'POST') {
      const payload = authorize(request, result, 'sales.write');
      if (!payload) return;
      const row = await store.getTaxSubmission(taxSendMatch[1]);
      if (!row) { fail(result, 'صورت‌حساب پیدا نشد', 404); return; }
      const outcome = await sendInvoiceToTaxSystem(JSON.parse(row.payload));
      const updated = outcome.ok
        ? await store.updateTaxSubmission(row.id, { status: 'ارسال شد', attempts: row.attempts + 1, referenceId: outcome.referenceId, lastError: undefined, sentAt: new Date().toISOString() })
        : await store.updateTaxSubmission(row.id, { status: 'ناموفق', attempts: row.attempts + 1, lastError: outcome.error });
      await store.recordAudit({ actor: payload.username, action: outcome.ok ? 'tax.send' : 'tax.fail', entity: 'tax-submission', detail: row.invoiceNumber });
      send(result, response(updated ? { ...updated, ok: outcome.ok, message: outcome.ok ? 'صورت‌حساب به سامانه‌ی مؤدیان ارسال شد' : outcome.error } : { ok: outcome.ok }));
      return;
    }

    const taxDeleteMatch = /^\/api\/tax\/submissions\/([\w-]+)$/.exec(path);
    if (taxDeleteMatch && request.method === 'DELETE') {
      const payload = authorize(request, result, 'sales.write');
      if (!payload) return;
      const removed = await store.deleteTaxSubmission(taxDeleteMatch[1]);
      if (!removed) { fail(result, 'فقط صورت‌حساب‌های در صف یا ناموفق حذف می‌شوند', 400); return; }
      send(result, response({ ok: true }));
      return;
    }

    /* --------------------------------- خرید --------------------------------- */

    if (path === '/api/purchasing/orders' && request.method === 'GET') {
      const payload = authorize(request, result, 'purchasing.read');
      if (!payload) return;
      const data = usingDatabase ? await listPurchaseOrders().catch(() => []) : await store.listPurchaseOrders(resolveOrganization(request, payload)).catch(() => []);
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/purchasing/orders' && request.method === 'POST') {
      const payload = authorize(request, result, 'purchasing.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof createPurchaseOrder>[0];
        const order = usingDatabase ? await createPurchaseOrder(input) : await store.createPurchaseOrderRecord({ ...input, organizationId: resolveOrganization(request, payload), createdBy: payload.username });
        send(result, response(order, 201));
      }
      catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت سفارش خرید ناموفق بود'); }
      return;
    }

    /* -------------------------------- انبار -------------------------------- */

    if (path === '/api/inventory/items' && request.method === 'GET') { const data = await listInventory().catch(() => []); send(result, response({ data, count: data.length })); return; }

    /* ------------------------- کاربران و دسترسی‌ها ------------------------- */

    if (path === '/api/identity/users' && request.method === 'GET') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      const data = await store.listUsers();
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/identity/users' && request.method === 'POST') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      try {
        const input = sanitize(JSON.parse(await readBody(request)) as store.CreateUserInput);
        const weak = passwordError(String(input.password ?? ''));
        if (weak) { fail(result, weak); return; }
        const user = await store.createUser(input);
        await store.recordAudit({ actor: payload.username, action: 'user.create', entity: 'user', entityId: user.id, detail: `${user.username} (${user.role})` });
        send(result, response(user, 201));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'ساخت کاربر ناموفق بود'); }
      return;
    }
    if (path.startsWith('/api/identity/users/') && request.method === 'PATCH') {
      const payload = authorize(request, result, 'identity.manage');
      if (!payload) return;
      try {
        const id = path.split('/').pop() ?? '';
        const { isActive } = JSON.parse(await readBody(request)) as { isActive?: boolean };
        await store.setUserActive(id, isActive !== false);
        await store.recordAudit({ actor: payload.username, action: isActive !== false ? 'user.activate' : 'user.deactivate', entity: 'user', entityId: id });
        send(result, response({ ok: true }));
      } catch (error) { fail(result, error instanceof Error ? error.message : 'تغییر وضعیت کاربر ناموفق بود'); }
      return;
    }

    /* ------------------------ منابع انسانی و حقوق ------------------------ */

    if (path === '/api/hr/employees' && request.method === 'GET') { const data = await listEmployees().catch(() => []); send(result, response({ data, count: data.length })); return; }
    if (path === '/api/payroll/runs' && request.method === 'POST') {
      const payload = authorize(request, result, 'payroll.write');
      if (!payload) return;
      try { send(result, response(await createPayroll(JSON.parse(await readBody(request)) as Parameters<typeof createPayroll>[0]), 201)); }
      catch (error) { fail(result, error instanceof Error ? error.message : 'محاسبه حقوق ناموفق بود'); }
      return;
    }


    if (path === '/api/fixed-assets/depreciation' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      let input: { assets?: DepreciableAsset[]; method?: DepreciationMethod; periodLabel?: string; assetId?: string; schedule?: boolean };
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      const assets = Array.isArray(input.assets) ? input.assets : [];
      const method: DepreciationMethod = DEPRECIATION_METHODS.some((item) => item.id === input.method) ? (input.method as DepreciationMethod) : 'straight-line';
      if (!assets.length) { fail(result, 'فهرست دارایی‌ها خالی است'); return; }
      if (input.schedule) {
        const asset = assets.find((item) => item.id === input.assetId) ?? assets[0];
        send(result, response({ asset: asset.assetCode, schedule: depreciationSchedule(asset, method) }));
        return;
      }
      send(result, response({ methods: DEPRECIATION_METHODS, ...depreciationRun(assets, method, input.periodLabel ?? 'دوره جاری') }));
      return;
    }
    /* --------------------------- دارایی‌های ثابت --------------------------- */

    if (path === '/api/fixed-assets' && request.method === 'GET') {
      const payload = authorize(request, result, 'accounting.read');
      if (!payload) return;
      const data = usingDatabase ? await listFixedAssets().catch(() => []) : await store.listFixedAssets(resolveOrganization(request, payload)).catch(() => []);
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/fixed-assets' && request.method === 'POST') {
      const payload = authorize(request, result, 'accounting.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof createFixedAsset>[0];
        const asset = usingDatabase ? await createFixedAsset(input) : await store.createFixedAssetRecord({ ...input, organizationId: resolveOrganization(request, payload) });
        send(result, response(asset, 201));
      }
      catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت دارایی ناموفق بود'); }
      return;
    }

    /* ------------------------------ تولید ------------------------------ */

    if (path === '/api/manufacturing/boms' && request.method === 'GET') {
      const payload = authorize(request, result, 'inventory.read');
      if (!payload) return;
      const data = await listBoms(resolveOrganization(request, payload)).catch(() => []);
      send(result, response({ data: data.map((bom) => ({ ...bom, estimatedUnitCost: estimateUnitCost(bom) })), count: data.length }));
      return;
    }

    if (path === '/api/manufacturing/boms' && request.method === 'POST') {
      const payload = authorize(request, result, 'inventory.write');
      if (!payload) return;
      let input: Parameters<typeof createBom>[0];
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      try { const record = await createBom(input); await store.recordAudit({ actor: payload.username, action: 'bom.create', entity: 'bom', entityId: record.id }); send(result, response(record, 201)); }
      catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت BOM ناموفق بود'); }
      return;
    }

    if (path.startsWith('/api/manufacturing/boms/') && request.method === 'DELETE') {
      const payload = authorize(request, result, 'inventory.write');
      if (!payload) return;
      const id = decodeURIComponent(path.slice('/api/manufacturing/boms/'.length));
      const removed = await deleteBom(id).catch(() => false);
      if (!removed) { fail(result, 'BOM یافت نشد', 404); return; }
      send(result, response({ id, removed: true }));
      return;
    }

    if (path === '/api/manufacturing/cost' && request.method === 'POST') {
      const payload = authorize(request, result, 'inventory.read');
      if (!payload) return;
      let input: ProductionCostInput & { bomId?: string };
      try { input = JSON.parse(await readBody(request)) as typeof input; } catch { fail(result, 'بدنه‌ی درخواست معتبر نیست'); return; }
      const bom = input.bom ?? (input.bomId ? await findBom(input.bomId).catch(() => null) : null);
      if (!bom) { fail(result, 'صورت مواد (BOM) مشخص نشده است'); return; }
      if (!(Number(input.quantity) > 0)) { fail(result, 'تعداد تولید باید بزرگ‌تر از صفر باشد'); return; }
      send(result, response(productionCost({ ...input, bom })));
      return;
    }

    if (path === '/api/manufacturing/orders' && request.method === 'GET') {
      const payload = authorize(request, result, 'inventory.read');
      if (!payload) return;
      const data = usingDatabase ? await listProductionOrders().catch(() => []) : await store.listProductionOrders(resolveOrganization(request, payload)).catch(() => []);
      send(result, response({ data, count: data.length }));
      return;
    }
    if (path === '/api/manufacturing/orders' && request.method === 'POST') {
      const payload = authorize(request, result, 'inventory.write');
      if (!payload) return;
      try {
        const input = JSON.parse(await readBody(request)) as Parameters<typeof createProductionOrder>[0];
        const order = usingDatabase ? await createProductionOrder(input) : await store.createProductionOrderRecord({ ...input, organizationId: resolveOrganization(request, payload) });
        send(result, response(order, 201));
      }
      catch (error) { fail(result, error instanceof Error ? error.message : 'ثبت سفارش تولید ناموفق بود'); }
      return;
    }

    fail(result, 'مسیر API پیدا نشد', 404);
  };

  void route().catch((error: Error) => fail(result, error.message, 500));
});

const start = async (): Promise<void> => {
  await store.seed();
  if (usingDatabase) {
    try {
      const { Client } = await import('pg');
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const results = await runMigrations(client);
        const applied = results.filter((item) => item.applied).length;
        console.log(`PostgreSQL ready: ${results.length} مهاجرت بررسی شد، ${applied} مورد اجرا شد`);
        const seeded = await seedDatabase(client);
        console.log(`داده‌های پایه: ${seeded.users} کاربر، ${seeded.roles} نقش، ${seeded.permissions} انتساب دسترسی`);
      } finally {
        await client.end();
      }
    } catch (error) {
      console.error(`Database initialization failed: ${(error as Error).message}`);
    }
  }
  server.listen(port, '0.0.0.0', () => console.log(`ERP web server listening on http://0.0.0.0:${port}${serveStatic ? ' (serving dist + API)' : ' (API only)'} — storage: ${usingDatabase ? 'postgresql' : 'file'}`));
// پشتیبان‌گیریِ خودکار (در صورت تنظیم در .env)
startAutoBackup();
};

void start();
