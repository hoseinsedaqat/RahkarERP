/**
 * =====================================================================
 * پشتیبان‌گیریِ خودکار
 * =====================================================================
 * با تنظیمِ BACKUP_INTERVAL_HOURS در فایل .env، سرور هر چند ساعت یک‌بار
 * از همه‌ی داده‌ها نسخه می‌گیرد و آن را در پوشه‌ی پشتیبان‌ها می‌نویسد.
 * تعدادِ نسخه‌های نگه‌داری‌شده با BACKUP_KEEP کنترل می‌شود.
 *
 * پیش‌فرض: ۱۲ ساعت یک‌بار، نگهداریِ ۱۴ نسخه. برای غیرفعال‌کردن: BACKUP_INTERVAL_HOURS=0
 */
import { mkdirSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportSnapshot } from './store.js';

const dataDirectory = resolve(process.cwd(), process.env.DATA_DIR ?? '.data');
const backupDirectory = resolve(process.cwd(), process.env.BACKUP_DIR ?? join(process.env.DATA_DIR ?? '.data', 'backups'));
const intervalHours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 12);
const keepCount = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14));

const stamp = (date = new Date()): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

/** یک نسخه‌ی پشتیبانِ زمان‌دار می‌سازد و نامِ فایل را برمی‌گرداند */
export function takeBackup(): string | null {
  try {
    mkdirSync(backupDirectory, { recursive: true });
    const fileName = `backup-${stamp()}.json`;
    const content = JSON.stringify(exportSnapshot(), null, 2);
    writeFileSync(join(backupDirectory, fileName), content, 'utf8');
    pruneBackups();
    return fileName;
  } catch {
    return null;
  }
}

/** نسخه‌های قدیمی را پاک می‌کند تا فقط تعدادِ مجاز باقی بماند */
export function pruneBackups(): void {
  try {
    const files = readdirSync(backupDirectory)
      .filter((name) => name.startsWith('backup-') && name.endsWith('.json'))
      .map((name) => ({ name, at: statSync(join(backupDirectory, name)).mtimeMs }))
      .sort((left, right) => right.at - left.at);
    files.slice(keepCount).forEach((file) => rmSync(join(backupDirectory, file.name), { force: true }));
  } catch { /* پوشه هنوز وجود ندارد */ }
}

export type BackupEntry = { name: string; at: string; size: number };

/** فهرستِ نسخه‌های موجود (برای نمایش در پنلِ پشتیبان‌گیری) */
export function listBackups(): BackupEntry[] {
  try {
    mkdirSync(backupDirectory, { recursive: true });
    return readdirSync(backupDirectory)
      .filter((name) => name.startsWith('backup-') && name.endsWith('.json'))
      .map((name) => {
        const info = statSync(join(backupDirectory, name));
        return { name, at: new Date(info.mtimeMs).toISOString(), size: info.size };
      })
      .sort((left, right) => right.at.localeCompare(left.at));
  } catch {
    return [];
  }
}

export const backupPath = (name: string): string => {
  if (!/^backup-[\w.-]+\.json$/.test(name)) throw new Error('نام فایل معتبر نیست');
  return join(backupDirectory, name);
};

/** راه‌اندازیِ زمان‌بند؛ در صورت غیرفعال بودن کاری نمی‌کند */
export function startAutoBackup(): void {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return;
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
  const run = (): void => {
    const file = takeBackup();
    if (file) console.log(`[پشتیبان] نسخه‌ی خودکار ذخیره شد: ${file}`);
  };
  // نخستین نسخه اندکی پس از بالا آمدنِ سرور
  setTimeout(run, 60_000).unref?.();
  setInterval(run, intervalMs).unref?.();
  console.log(`[پشتیبان] پشتیبان‌گیریِ خودکار هر ${intervalHours} ساعت (نگهداری ${keepCount} نسخه) در ${dataDirectory}`);
}
