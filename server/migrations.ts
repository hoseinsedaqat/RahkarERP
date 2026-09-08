import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** حداقل قرارداد مورد نیاز از یک اتصال پایگاه برای اجرای مهاجرت‌ها */
export type MigrationClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type MigrationResult = { version: string; name: string; applied: boolean; checksum: string };

const migrationsDirectory = resolve(process.cwd(), 'database', 'migrations');

/**
 * اجرای همه‌ی مهاجرت‌های اجرانشده به ترتیب نام فایل.
 * هر مهاجرت در یک تراکنش اجرا می‌شود و همراه با اثر انگشت (checksum) فایل
 * در جدول schema_migrations ثبت می‌شود تا اجرای دوباره آن بی‌اثر باشد.
 */
export async function runMigrations(client: MigrationClient, directory = migrationsDirectory): Promise<MigrationResult[]> {
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  } catch (error) {
    // برخی شبیه‌سازها هنگام وجودِ جدول خطا می‌دهند؛ در این صورت از وجود آن مطمئن می‌شویم
    try {
      await client.query('SELECT version FROM schema_migrations');
    } catch {
      throw new Error(`ایجاد جدول schema_migrations ناموفق بود: ${(error as Error).message}`);
    }
  }

  const appliedRows = (await client.query('SELECT version FROM schema_migrations')).rows;
  const applied = new Set(appliedRows.map((row) => String(row.version)));

  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const results: MigrationResult[] = [];

  for (const file of files) {
    const version = file.split('_')[0] ?? file;
    const sql = (await readFile(resolve(directory, file), 'utf8')).trim();
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    if (applied.has(version)) {
      results.push({ version, name: file, applied: false, checksum });
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [version, file, checksum]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`اجرای مهاجرت ${file} ناموفق بود: ${(error as Error).message}`);
    }
    results.push({ version, name: file, applied: true, checksum });
  }

  return results;
}

/** فهرست مهاجرت‌های اعمال‌شده برای نمایش در گزارش یا بررسی سلامت */
export async function listMigrations(client: MigrationClient): Promise<Array<{ version: string; name: string; appliedAt: string }>> {
  const rows = (await client.query('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')).rows;
  return rows.map((row) => ({ version: String(row.version), name: String(row.name), appliedAt: String(row.applied_at) }));
}
