/**
 * بالا آوردنِ سرور — همیشه با ساختِ تازه.
 *
 * چرا این اسکریپت لازم است؟ بارها پیش آمده که پوشه‌ی خروجی (dist) به نسخه‌ای کهنه
 * برگردد (بازنشانیِ محیط، بازگردانی از مخزن) و کاربر در عمل نسخه‌ای قدیمی از برنامه
 * را ببیند؛ در حالی که کد درست بود. برای اینکه چنین اشتباهی دیگر رخ ندهد، هر بار
 * بالا آوردن، ابتدا خروجی از روی کدِ فعلی ساخته می‌شود و سپس سرویس اجرا می‌گردد.
 *
 * اجرا:  npm start
 * برای رد کردنِ مرحله‌ی ساخت (وقتی dist آماده است):  SKIP_BUILD=1 npm start
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';

const step = (label) => console.log(`▸ ${label}`);

/**
 * روی ویندوز، npm یک فایلِ دسته‌ای (npm.cmd) است نه یک باینری؛ بنابراین باید با shell
 * اجرا شود وگرنه spawn با خطای ENOENT / EINVAL شکست می‌خورد. (Node ≥ 18.20 اجرای
 * فایل‌های .cmd بدون shell را به دلایل امنیتی ممنوع کرده است.)
 */
const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';

const run = (command, args) => new Promise((done) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: isWindows });
  child.on('error', (error) => { console.error(`اجرای «${command}» ممکن نشد: ${error.message}`); done(1); });
  child.on('exit', (code) => done(code ?? 0));
});

/** اگر وابستگی‌ها نصب نباشند، نصب می‌شوند (بازنشانیِ محیط آن‌ها را پاک می‌کند) */
const depsReady = () => existsSync('node_modules/vite/package.json') && existsSync('node_modules/typescript/package.json') && existsSync('node_modules/tsx/package.json');
if (!depsReady()) {
  step('نصبِ وابستگی‌ها…');
  const code = await run(npmCommand, ['install', '--no-audit', '--no-fund']);
  if (code !== 0) { console.error('نصب ناموفق بود.'); process.exit(code); }
}

/** ساختِ خروجی از روی کدِ فعلی */
const skipBuild = process.env.SKIP_BUILD === '1' && existsSync('dist/index.html');
if (skipBuild) {
  step('ساخت رد شد (SKIP_BUILD=1)؛ از خروجیِ موجود استفاده می‌شود.');
} else {
  step('ساختِ خروجی از روی کدِ فعلی…');
  const code = await run(npmCommand, ['run', 'build']);
  if (code !== 0) { console.error('ساخت ناموفق بود.'); process.exit(code); }
}

const assets = existsSync('dist/assets') ? readdirSync('dist/assets').filter((f) => f.endsWith('.js')) : [];
const bundle = assets[0] ? statSync(`dist/assets/${assets[0]}`) : null;
step(`خروجی آماده است: ${assets[0] ?? '—'} (${bundle ? Math.round(bundle.size / 1024) : 0} کیلوبایت)`);

step('بالا آوردنِ سرویس…');
// از همان باینریِ Node که این اسکریپت را اجرا کرده استفاده می‌شود (نه «node» از PATH)
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { stdio: 'inherit' });
server.on('error', (error) => { console.error(`اجرای سرور ممکن نشد: ${error.message}`); process.exit(1); });
server.on('exit', (serverCode) => process.exit(serverCode ?? 0));

// با بستنِ پنجره یا Ctrl+C، سرور هم بسته می‌شود
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.kill(signal); });
}
