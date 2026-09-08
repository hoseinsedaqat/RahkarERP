/**
 * اجرای همه‌ی سناریوهای end-to-end روی خروجیِ ساخته‌شده (dist).
 * پیش‌نیاز: سرور روی همان نشانیِ BASE در حال اجرا باشد.
 * اجرا: npm run test:e2e
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((file) => file.endsWith('.mjs') && file !== 'harness.mjs' && file !== 'run.mjs').sort();

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  child.on('close', (code) => resolve({ file, code, output }));
});

console.log(`اجرای ${suites.length} مجموعه‌ی end-to-end\n`);
let failed = 0;
for (const suite of suites) {
  const { code, output } = await run(suite);
  const lines = output.trim().split('\n');
  const tail = lines.slice(-2).join(' — ').replace(/\s+/g, ' ').trim();
  console.log(`${code === 0 ? '✅' : '❌'} ${suite}: ${tail}`);
  if (code !== 0) {
    failed += 1;
    console.log(lines.filter((line) => /✗|❌/.test(line)).map((line) => `     ${line.trim()}`).join('\n'));
  }
}
console.log(failed ? `\n${failed} مجموعه ناموفق بود` : '\nهمه‌ی سناریوهای end-to-end موفق ✓');
process.exit(failed ? 1 : 0);
