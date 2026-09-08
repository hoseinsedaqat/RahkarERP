/**
 * دوامِ نشست در بدترین شرایط (شبیه‌سازیِ میزبانیِ موقت):
 *  ۱) توکن پس از راه‌اندازیِ دوباره‌ی سرویس معتبر می‌ماند (کلیدِ امضا پایدار است)
 *  ۲) اگر فهرستِ نشست‌هایِ سرور پاک شود، نشستِ کاربر بازیابی می‌شود نه باطل
 *  ۳) سرویس شناسه و اثرِ کلید را در پاسخ می‌فرستد تا عوض شدنش قابل تشخیص باشد
 *
 * این تست روی یک نمونه‌ی جدا (پورت و پوشه‌ی داده‌ی موقت) اجرا می‌شود،
 * بنابراین هرگز به داده‌ها یا سرویسِ اصلی دست نمی‌زند.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` ${detail}` : ''}`);
};

const port = 8097;
const base = `http://localhost:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'rahkar-durability-'));
const repo = new URL('../../', import.meta.url).pathname;

const health = async () => {
  try { const r = await fetch(`${base}/api/health`, { cache: 'no-store' }); return r.ok ? r : null; } catch { return null; }
};
const start = () => spawn('node', ['--import', 'tsx', 'server/index.ts'], {
  cwd: repo, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'ignore',
});
const waitReady = async (child) => {
  for (let i = 0; i < 40; i += 1) { await wait(500); if (await health()) return true; }
  child.kill('SIGKILL');
  return false;
};

let child = start();
try {
  check('نمونه‌ی آزمایشی بالا آمد', await waitReady(child));

  const login = await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  check('ورود انجام می‌شود', Boolean(login?.token && login?.refreshToken));

  const firstHealth = await health();
  const firstHeaders = firstHealth ? { server: firstHealth.headers.get('x-server-id'), secret: firstHealth.headers.get('x-secret-id') } : {};
  check('سرور شناسه و اثرِ کلید می‌فرستد', Boolean(firstHeaders.server && firstHeaders.secret), `${firstHeaders.server} / ${firstHeaders.secret}`);

  /* ---------- ۱) راه‌اندازیِ دوباره ---------- */
  child.kill('SIGTERM');
  await wait(1500);
  child = start();
  check('نمونه‌ی آزمایشی دوباره بالا آمد', await waitReady(child));

  const afterRestart = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${login.token}` } });
  check('توکن پس از راه‌اندازیِ دوباره معتبر است', afterRestart.status === 200, `وضعیت: ${afterRestart.status}`);

  /* ---------- ۲) پاک شدنِ فهرستِ نشست‌ها ---------- */
  const storePath = join(dataDir, 'store.json');
  const database = JSON.parse(readFileSync(storePath, 'utf8'));
  const hadTokens = database.refreshTokens?.length ?? 0;
  database.refreshTokens = [];
  writeFileSync(storePath, JSON.stringify(database, null, 2), 'utf8');
  check('فهرستِ نشست‌ها برای آزمایش پاک شد', hadTokens > 0, `${hadTokens} نشست`);

  child.kill('SIGTERM');
  await wait(1500);
  child = start();
  check('نمونه پس از پاک شدنِ پایگاه بالا آمد', await waitReady(child));

  const refresh = await fetch(`${base}/api/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: login.refreshToken }),
  });
  const refreshed = await refresh.json().catch(() => ({}));
  check('نشست پس از پاک شدنِ پایگاه بازیابی می‌شود', refresh.status === 200, `وضعیت: ${refresh.status} ${refreshed.error ?? ''}`);
  if (refresh.status === 200) {
    const me = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${refreshed.token}` } });
    check('دسترسی با توکنِ تازه برقرار است', me.status === 200, `وضعیت: ${me.status}`);
  }

  /* ---------- ۳) ثباتِ شناسه در یک اجرا ---------- */
  const a = await health();
  const b = await health();
  check('شناسه‌ی سرویس در یک اجرا ثابت است', a?.headers.get('x-server-id') === b?.headers.get('x-server-id'));
} finally {
  child.kill('SIGTERM');
  await wait(500);
  child.kill('SIGKILL');
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* پوشه‌ی موقت پاک نشد؛ اشکالی ندارد */ }
}

console.log(`\nنتیجه: ${failures ? `${failures} مورد ناموفق` : 'همه‌ی بررسی‌ها موفق'}`);
process.exit(failures ? 1 : 0);
