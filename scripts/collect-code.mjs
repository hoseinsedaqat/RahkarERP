/**
 * گردآوریِ همه‌ی کدِ برنامه در یک فایلِ واحد
 * ---------------------------------------------------------------------
 * هدف: بتوانید کلِ پروژه را در یک فایل ببینید، جست‌وجو کنید یا برای
 * بررسی/نگه‌داری در اختیارِ یک دستیارِ دیگر بگذارید.
 *
 * اجرا:   npm run code:collect
 * خروجی:  کد-کامل/همه-کد.txt
 *
 * پوشه‌های dist، node_modules، .git و .data شامل نمی‌شوند (خروجی و داده‌اند، کد نیستند).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'کد-کامل');
const outFile = join(outDir, 'همه-کد.txt');

const skipDirs = new Set(['node_modules', '.git', '.data', 'dist', 'dist-demo', 'dist-win', 'coverage', '.cache', 'کد-کامل', '.github']);
const codeExt = new Set(['.ts', '.mjs', '.js', '.css', '.html', '.json', '.yml', '.yaml', '.md', '.bat', '.sql', '.svg', '.txt']);
const skipFiles = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

/** گردش در پوشه‌ها و گردآوریِ فایل‌های کد */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (skipDirs.has(entry) || entry.startsWith('.')) continue;
      walk(full, acc);
      continue;
    }
    if (skipFiles.has(entry)) continue;
    if (!codeExt.has(extname(entry).toLowerCase())) continue;
    acc.push(full);
  }
  return acc;
}

const files = walk(root).sort((a, b) => relative(root, a).localeCompare(relative(root, b), 'fa'));
const fence = (path) => {
  const ext = extname(path).toLowerCase().replace('.', '');
  return ext === 'md' ? 'markdown' : ext === 'yml' ? 'yaml' : ext === 'bat' ? 'bat' : ext || 'text';
};

let output = '';
output += '════════════════════════════════════════════════════════════════════\n';
output += '  همه‌ی کدِ «راهکار» در یک فایل\n';
output += `  تاریخِ تولید: ${new Date().toLocaleString('fa-IR')}\n`;
output += `  تعدادِ فایل‌ها: ${files.length}\n`;
output += '  برای بازسازی این فایل:  npm run code:collect\n';
output += '════════════════════════════════════════════════════════════════════\n\n';
output += 'فهرست:\n';
files.forEach((file, index) => {
  const lines = readFileSync(file, 'utf8').split('\n').length;
  output += `${String(index + 1).padStart(3, ' ')}. ${relative(root, file)}  (${lines} خط)\n`;
});
output += '\n';

for (const file of files) {
  const rel = relative(root, file);
  const content = readFileSync(file, 'utf8');
  output += `\n${'─'.repeat(76)}\n`;
  output += `📄 ${rel}\n`;
  output += `${'─'.repeat(76)}\n\n`;
  output += `\`\`\`${fence(file)}\n${content}\n\`\`\`\n`;
}

mkdirSync(outDir, { recursive: true });
if (existsSync(outFile)) writeFileSync(join(outDir, 'همه-کد-قبلی.txt'), readFileSync(outFile, 'utf8'));
writeFileSync(outFile, output);
const size = (Buffer.byteLength(output, 'utf8') / 1024 / 1024).toFixed(2);
console.log(`همه‌ی کد در یک فایل گردآوری شد: کد-کامل/همه-کد.txt (${files.length} فایل، ${size} مگابایت)`);
