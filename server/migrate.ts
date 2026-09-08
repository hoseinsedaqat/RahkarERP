import { randomUUID } from 'node:crypto';
import { runMigrations, listMigrations, type MigrationClient } from './migrations.js';
import { seedDatabase } from './seed.js';

/**
 * ابزار خط فرمان مهاجرت پایگاه داده
 *
 *   npm run migrate                      اجرای آزمایشی روی PostgreSQL درون‌حافظه (بدون نیاز به سرور)
 *   DATABASE_URL=postgres://... npm run migrate    اجرا روی پایگاه واقعی
 *
 * در حالت بدون DATABASE_URL، شبیه‌ساز درون‌حافظه استفاده می‌شود تا درستی SQL
 * پیش از اجرا روی پایگاه واقعی تأیید شود.
 */

const connectionString = process.env.DATABASE_URL;

/** حذف دستوراتی که در شبیه‌ساز پشتیبانی نمی‌شوند */
const normalizeForSimulator = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !/^\s*CREATE\s+EXTENSION/i.test(line))
    .join('\n');

async function createSimulatorClient(): Promise<{ client: MigrationClient; close: () => Promise<void>; simulate: (sql: string) => Promise<void> }> {
  const { newDb, DataType } = await import('pg-mem');
  const database = newDb();
  database.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  const { Client } = database.adapters.createPg();
  const client = new Client() as unknown as MigrationClient & { connect?: () => Promise<void>; end?: () => Promise<void> };
  if (typeof client.connect === 'function') await client.connect();
  return {
    client,
    close: async () => {
      if (typeof client.end === 'function') await client.end();
    },
    simulate: async (sql: string) => {
      const { query } = client;
      // شبیه‌ساز دستورات چندگانه را مانند Postgres ساده اجرا می‌کند
      await query(normalizeForSimulator(sql));
    },
  };
}

async function main(): Promise<void> {
  if (connectionString) {
    const { Client } = await import('pg');
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const results = await runMigrations(client);
      if (!results.length) console.log('هیچ فایل مهاجرتی یافت نشد.');
      results.forEach((result) => console.log(`${result.applied ? '✔ اجرا شد' : '↷ از قبل اعمال‌شده'}  ${result.name}  (${result.checksum})`));
      await seedDatabase(client);
      console.log('داده‌های پایه (سازمان، کاربران، نقش‌ها) به‌روزرسانی شد.');
      const applied = await listMigrations(client);
      console.log(`تعداد مهاجرت‌های اعمال‌شده: ${applied.length}`);
    } finally {
      await client.end();
    }
    return;
  }

  console.log('DATABASE_URL تنظیم نشده است؛ اجرای آزمایشی روی پایگاه درون‌حافظه…');
  const simulator = await createSimulatorClient();
  const originalQuery = simulator.client.query.bind(simulator.client);
  simulator.client.query = ((sql: string, params?: unknown[]) =>
    (params ? originalQuery(normalizeForSimulator(sql), params) : originalQuery(normalizeForSimulator(sql)))) as typeof simulator.client.query;
  try {
    const results = await runMigrations(simulator.client);
    results.forEach((result) => console.log(`${result.applied ? '✔ اجرا شد' : '↷ از قبل اعمال‌شده'}  ${result.name}  (${result.checksum})`));
    const seeded = await seedDatabase(simulator.client);
    console.log(`✔ داده‌های پایه: سازمان «${seeded.organization}»، ${seeded.users} کاربر، ${seeded.roles} نقش، ${seeded.permissions} انتساب دسترسی، ۱۲ دوره مالی، ۱۲ حساب، ۵ مرکز هزینه`);
    const applied = await listMigrations(simulator.client);
    console.log(`\n✅ همه مهاجرت‌ها و داده‌های پایه بدون خطا اجرا شدند (${applied.length} مهاجرت). برای اجرا روی پایگاه واقعی، DATABASE_URL را تنظیم کنید.`);
  } finally {
    await simulator.close();
  }
}

void main().catch((error: Error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
