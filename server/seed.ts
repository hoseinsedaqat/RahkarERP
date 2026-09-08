import { hashPassword, roles, type RoleId } from './auth.js';

/** حداقل قرارداد مورد نیاز از اتصال پایگاه برای درج داده‌های پایه */
export type SeedClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

const organizationName = process.env.ORGANIZATION_NAME ?? 'گروه صنعتی آریا';
const organizationCode = process.env.ORGANIZATION_CODE ?? 'ARIA';

const seedUsers: Array<{ username: string; displayName: string; password: string; role: RoleId }> = [
  { username: 'admin', displayName: 'حسین صادقی', password: 'admin123', role: 'admin' },
  { username: 'hesabdari', displayName: 'مریم احمدی', password: '1234', role: 'accountant' },
  { username: 'foroosh', displayName: 'رضا کریمی', password: '1234', role: 'sales' },
  { username: 'anbar', displayName: 'سارا مرادی', password: '1234', role: 'warehouse' },
];

const baseAccounts: Array<[string, string]> = [
  ['1100', 'بانک و صندوق'],
  ['1200', 'حساب‌های دریافتنی'],
  ['1300', 'موجودی مواد و کالا'],
  ['1400', 'کالای در جریان ساخت'],
  ['1500', 'دارایی‌های ثابت'],
  ['1501', 'استهلاک انباشته'],
  ['2000', 'حساب‌های پرداختنی'],
  ['2100', 'حقوق و دستمزد پرداختنی'],
  ['2200', 'مالیات بر ارزش افزوده'],
  ['3000', 'سرمایه'],
  ['4000', 'درآمد فروش'],
  ['5000', 'بهای تمام‌شده کالای فروش‌رفته'],
  ['6000', 'هزینه‌های اداری و عمومی'],
  ['6100', 'هزینه حقوق و دستمزد'],
  ['6200', 'هزینه استهلاک'],
];

const baseCostCenters: Array<[string, string]> = [
  ['CC-1001', 'تولید'],
  ['CC-1002', 'فروش و بازاریابی'],
  ['CC-1003', 'اداری و عمومی'],
  ['CC-1004', 'تحقیق و توسعه'],
  ['CC-1005', 'پشتیبانی و خدمات پس از فروش'],
];

const persianMonths = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const monthLengths = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];

/** دوره‌های ماهانه‌ی سال ۱۴۰۵ با بازه‌ی تاریخی دقیق */
export function fiscalPeriodsOfYear(year = 1405, startIso = '2026-03-21', openIndex = 6): Array<{ title: string; startsOn: string; endsOn: string; status: string; index: number }> {
  let cursor = Date.parse(`${startIso}T00:00:00Z`);
  return persianMonths.map((month, position) => {
    const begins = new Date(cursor);
    const ends = new Date(cursor + (monthLengths[position] - 1) * 86_400_000);
    cursor = ends.getTime() + 86_400_000;
    return {
      title: `${month} ${year}`,
      startsOn: begins.toISOString().slice(0, 10),
      endsOn: ends.toISOString().slice(0, 10),
      status: position + 1 === openIndex ? 'open' : 'closed',
      index: position + 1,
    };
  });
}

/**
 * درج داده‌های پایه در PostgreSQL به‌صورت تکرارپذیر:
 * سازمان، کاربران، نقش‌ها، دسترسی‌ها و اتصال آن‌ها به یکدیگر.
 * هر بار اجرا بدون ایجاد رکورد تکراری، وضعیت را به‌روزرسانی می‌کند.
 */
export async function seedDatabase(client: SeedClient): Promise<{ organization: string; users: number; roles: number; permissions: number }> {
  const organization = await client.query(
    'INSERT INTO organizations (name, code) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id',
    [organizationName, organizationCode],
  );
  const organizationId = String(organization.rows[0].id);

  let permissionCount = 0;
  for (const [roleId, definition] of Object.entries(roles)) {
    const role = await client.query(
      'INSERT INTO roles (organization_id, name) VALUES ($1, $2) ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
      [organizationId, definition.title],
    );
    const roleRowId = String(role.rows[0].id);
    for (const permission of definition.permissions) {
      const record = await client.query(
        'INSERT INTO permissions (code, description) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description RETURNING id',
        [permission, `دسترسی ${permission} برای نقش ${definition.title}`],
      );
      await client.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [roleRowId, String(record.rows[0].id)],
      );
      permissionCount += 1;
    }
    // کاربران این نقش
    for (const user of seedUsers.filter((item) => item.role === (roleId as RoleId))) {
      const userRow = await client.query(
        `INSERT INTO users (username, password_hash, display_name, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [user.username, hashPassword(user.password), user.displayName],
      );
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [String(userRow.rows[0].id), roleRowId]);
    }
  }

  for (const [code, title] of baseAccounts) {
    await client.query('INSERT INTO accounts (organization_id, code, title, level) VALUES ($1, $2, $3, 1) ON CONFLICT (organization_id, code) DO NOTHING', [organizationId, code, title]);
  }
  for (const [code, title] of baseCostCenters) {
    await client.query('INSERT INTO cost_centers (organization_id, code, title) VALUES ($1, $2, $3) ON CONFLICT (organization_id, code) DO NOTHING', [organizationId, code, title]);
  }
  for (const period of fiscalPeriodsOfYear()) {
    await client.query(
      `INSERT INTO fiscal_periods (organization_id, title, starts_on, ends_on, status, year, period_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (organization_id, title) DO NOTHING`,
      [organizationId, period.title, period.startsOn, period.endsOn, period.status, 1405, period.index],
    );
  }

  return { organization: organizationName, users: seedUsers.length, roles: Object.keys(roles).length, permissions: permissionCount };
}
