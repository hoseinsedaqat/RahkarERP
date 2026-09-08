import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hashPassword, type RoleId } from './auth.js';
import { balanceSheet, currency, generalLedger, profitLoss, subsidiaryLedger, type LedgerLine } from './accounting-engine.js';
import { fifoIssueCost, reconcileBank, wacCosting, type BankLedgerLine, type BankStatementRow, type StockMovement as OpsStockMovement } from './operations-engine.js';
import { calculatePayroll, summarizePayroll, type PayrollInput, type PayrollResult } from './payroll-engine.js';

/**
 * لایه‌ی ذخیره‌سازی پیش‌فرضِ سرور: یک فایل JSON در پوشه‌ی `.data`.
 * - بدون نیاز به هیچ دیتابیس خارجی اجرا می‌شود و بعد از ری‌استارت هم باقی می‌ماند.
 * - نوشتن‌ها به‌صورت اتمیک (فایل موقت + rename) و پشت صف انجام می‌شوند تا تداخل پیش نیاید.
 * - وقتی DATABASE_URL تنظیم شود، داده‌های عملیاتی از PostgreSQL خوانده می‌شوند
 *   و این فروشگاه برای کاربران، شماره‌گذاری اسناد و ردیابی عملیات به‌کار می‌رود.
 */

export type UserRecord = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: RoleId;
  isActive: boolean;
  createdAt: string;
};

export type StoredEvent = {
  id: string;
  title: string;
  moduleId: string;
  amount: number;
  priority: string;
  status: string;
  createdAt: string;
  createdBy?: string;
  organizationId?: string;
};

export type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId?: string;
  detail?: string;
};

export type FiscalPeriod = {
  id: string;
  year: number;
  index: number;
  title: string;
  startsOn: string;
  endsOn: string;
  status: 'باز' | 'بسته';
  organizationId?: string;
};

export type CostCenter = { id: string; code: string; title: string; isActive: boolean; organizationId?: string };

export type WorkflowStep = { at: string; actor: string; action: string; from: string; to: string; comment?: string };

export type DocumentRecord = {
  id: string;
  number: number;
  title: string;
  moduleId: string;
  amount: number;
  priority: string;
  status: string;
  history: WorkflowStep[];
  periodId?: string;
  costCenterId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  organizationId?: string;
};

export type StockMovement = OpsStockMovement;
export type PayrollRecord = {
  id: string;
  period: string;
  personnelCode: string;
  fullName: string;
  input: PayrollInput;
  result: PayrollResult;
  journalId?: string;
  createdBy?: string;
  createdAt: string;
  organizationId?: string;
};
export type CheckRecord = {
  id: string;
  number: string;
  serial: string;
  bank: string;
  amount: number;
  issueDate: string;
  dueDate: string;
  direction: 'دریافتنی' | 'پرداختنی';
  party: string;
  status: 'در جریان وصول' | 'وصول شده' | 'پرداخت شده' | 'برگشتی' | 'باطل شده';
  description?: string;
  createdBy?: string;
  createdAt: string;
  organizationId?: string;
};
export type BankStatementRecord = BankStatementRow;
export type JournalLine = { accountCode: string; accountTitle: string; debit: number; credit: number; costCenter?: string };

export type JournalEntry = {
  id: string;
  number: number;
  description: string;
  sourceType: string;
  sourceId?: string;
  moduleId?: string;
  lines: JournalLine[];
  totalDebit: number;
  totalCredit: number;
  status: 'پیش‌نویس' | 'قطعی';
  periodId?: string;
  costCenterId?: string;
  createdBy?: string;
  createdAt: string;
  postedAt?: string;
  postedBy?: string;
  organizationId?: string;
};

export type AccountBalance = { code: string; title: string; debit: number; credit: number; balance: number };

/** یک قلم از صورت مواد (BOM): ماده/قطعه و مقدار مصرف برای هر واحد محصول */
export type BomComponent = { itemId: string; title: string; quantity: number; unit: string; unitCost: number; scrapPercent?: number };

/** صورت مواد و دستور ساخت محصول */
export type BomRecord = {
  id: string;
  code: string;
  product: string;
  outputQuantity: number;
  components: BomComponent[];
  laborMinutes: number;
  laborRatePerMinute: number;
  overheadPerUnit: number;
  note?: string;
  createdAt: string;
  organizationId?: string;
};

/** وضعیت‌های چرخه‌ی عمر یک شماره سریال */
export type SerialStatus = 'موجود در انبار' | 'تخصیص‌یافته' | 'فروخته‌شده' | 'برگشتی' | 'اسقاط';

/** شماره سریال (شناسه‌ی یکتای هر واحد کالا) */
export type SerialRecord = {
  id: string;
  serial: string;
  itemId: string;
  itemTitle: string;
  warehouse: string;
  status: SerialStatus;
  documentId?: string;
  party?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  organizationId?: string;
};

/** شرکت / کسب‌وکارِ مستقل؛ هر شرکت داده‌ی مالی و عملیاتی کاملاً جدای خود را دارد */
export type OrganizationRecord = {
  id: string;
  name: string;
  code: string;
  nationalId?: string;
  economicCode?: string;
  address?: string;
  phone?: string;
  /** واحد پول پیش‌فرض */
  currency: string;
  /** آغاز سال مالی (ماه شمسی ۱ تا ۱۲) */
  fiscalYearStartMonth: number;
  isActive: boolean;
  createdAt: string;
};

/** عضویت کاربر در یک شرکت همراه با نقشِ اختصاصیِ همان شرکت */
export type MembershipRecord = {
  id: string;
  userId: string;
  organizationId: string;
  role: RoleId;
  isDefault: boolean;
  createdAt: string;
};

/** توکن تازه‌سازیِ صادرشده؛ برای ابطالِ سروری و تشخیصِ استفاده‌ی مجدد */
export type RefreshTokenRecord = {
  id: string;
  userId: string;
  username: string;
  /** اثر هش‌شده‌ی توکن؛ خود توکن هرگز ذخیره نمی‌شود */
  tokenHash: string;
  familyId: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  /** اثرِ دستگاه/مرورگر (برای تشخیصِ استفاده‌ی هم‌زمانِ خودِ کاربر از استفاده‌ی غیرمجاز) */
  fingerprint?: string;
};

export type Database = {
  users: UserRecord[];
  events: StoredEvent[];
  audit: AuditEntry[];
  counters: Record<string, number>;
  periods: FiscalPeriod[];
  costCenters: CostCenter[];
  documents: DocumentRecord[];
  journals: JournalEntry[];
  stockMovements: StockMovement[];
  bankStatements: BankStatementRow[];
  payrollRecords: PayrollRecord[];
  checks: CheckRecord[];
  boms: BomRecord[];
  serials: SerialRecord[];
  organizations: OrganizationRecord[];
  memberships: MembershipRecord[];
  refreshTokens: RefreshTokenRecord[];
  recurringEntries: RecurringEntry[];
  treasuryTransactions: TreasuryTransactionRecord[];
  salesInvoices: SalesInvoiceRecord[];
  purchaseOrders: PurchaseOrderRecord[];
  fixedAssets: FixedAssetRecord[];
  productionOrders: ProductionOrderRecord[];
  taxSubmissions: TaxSubmissionRecord[];
  /** فضای کاریِ هر شرکت: داده‌های ماژول‌های برنامه (فاکتورها، سفارش‌ها، کالاها، …) که پیش‌تر فقط در مرورگر می‌ماند */
  workspaces: WorkspaceRecord[];
  /** کلیدِ امضای توکن (فقط وقتی اپراتور JWT_SECRET را تنظیم نکرده باشد)؛ همراهِ داده و پشتیبان‌ها می‌ماند */
  jwtSecret?: string;
};

export type WorkspaceRecord = {
  organizationId: string;
  /** کلید → مقدار (مثلاً erp-sales → آرایه‌ی فاکتورها) */
  entries: Record<string, unknown>;
  updatedAt: string;
  updatedBy?: string;
};
export type TreasuryTransactionRecord = {
  id: string; organizationId: string; transactionType: 'receipt' | 'payment';
  accountTitle: string; bankOrCash: string; amount: number; description: string;
  status: string; createdAt: string; journalId?: string;
};
export type SalesInvoiceRecord = {
  id: string; organizationId: string; invoiceNumber: number; customerName: string;
  subtotal: number; discount: number; tax: number; total: number; status: string;
  lines: Array<{ itemTitle: string; quantity: number; unitPrice: number }>;
  journalId?: string; createdAt: string;
};
export type PurchaseOrderRecord = {
  id: string; organizationId: string; orderNumber: number; supplierName: string;
  itemTitle: string; quantity: number; unitPrice: number; total: number; status: string;
  journalId?: string; createdAt: string;
};
export type FixedAssetRecord = {
  id: string; organizationId: string; assetCode: string; title: string; location: string;
  acquisitionCost: number; usefulLifeMonths: number; accumulatedDepreciation: number; status: string; createdAt: string;
};
export type ProductionOrderRecord = {
  id: string; organizationId: string; orderNumber: number; productTitle: string;
  plannedQuantity: number; materialTitle: string; materialQuantity: number;
  materialCost: number; laborCost: number; totalCost: number; status: string; createdAt: string;
};

/** الگوی سندِ تکرارشونده (اجاره، استهلاک، حقوقِ ثابت، آبونمان …) */
export type RecurringEntry = {
  id: string;
  organizationId: string;
  title: string;
  debitAccount: string;
  debitTitle: string;
  creditAccount: string;
  creditTitle: string;
  amount: number;
  frequency: 'monthly' | 'quarterly' | 'yearly';
  startDate: string;
  lastRun?: string;
  runs: number;
  isActive: boolean;
  createdAt: string;
};

const dataDirectory = resolve(process.cwd(), process.env.DATA_DIR ?? '.data');
const dataFile = join(dataDirectory, 'store.json');

const emptyDatabase = (): Database => ({ users: [], events: [], audit: [], counters: {}, periods: [], costCenters: [], documents: [], journals: [], stockMovements: [], bankStatements: [], payrollRecords: [], checks: [], boms: [], serials: [], organizations: [], memberships: [], refreshTokens: [], recurringEntries: [], treasuryTransactions: [], salesInvoices: [], purchaseOrders: [], fixedAssets: [], productionOrders: [], taxSubmissions: [], workspaces: [] });

let cache: Database | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * اطمینان از وجود شرکت پیش‌فرض و عضویت کاربران.
 * داده‌های قدیمی (بدون شناسه شرکت) به شرکت پیش‌فرض منتسب می‌شوند،
 * بنابراین ارتقا به نسخه‌ی چندشرکتی هیچ داده‌ای را از بین نمی‌برد.
 */
function ensureOrganizationScaffold(database: Database): void {
  if (!database.organizations.length) {
    database.organizations.push({
      id: 'org-default',
      name: process.env.ORGANIZATION_NAME ?? 'گروه صنعتی آریا',
      code: process.env.ORGANIZATION_CODE ?? 'ARIA',
      currency: 'ریال',
      fiscalYearStartMonth: 1,
      isActive: true,
      createdAt: new Date().toISOString(),
    });
  }
  const primary = database.organizations[0].id;

  // انتساب داده‌های قدیمی به شرکت پیش‌فرض
  const collections: Array<Array<{ organizationId?: string }>> = [
    database.events, database.periods, database.costCenters, database.documents,
    database.journals, database.stockMovements, database.payrollRecords,
    database.checks, database.boms, database.serials,
  ];
  for (const collection of collections) {
    for (const row of collection) if (!row.organizationId) row.organizationId = primary;
  }

  // عضویت پیش‌فرض برای همه‌ی کاربران
  for (const user of database.users) {
    const has = database.memberships.some((row) => row.userId === user.id);
    if (!has) {
      database.memberships.push({
        id: randomUUID(),
        userId: user.id,
        organizationId: primary,
        role: (user.role ?? 'viewer') as RoleId,
        isDefault: true,
        createdAt: new Date().toISOString(),
      });
    }
  }
}

function load(): Database {
  if (cache) return cache;
  if (existsSync(dataFile)) {
    try {
      const parsed = JSON.parse(readFileSync(dataFile, 'utf8')) as Partial<Database>;
      const base = emptyDatabase();
      const database: Database = {
        users: parsed.users ?? base.users,
        events: parsed.events ?? base.events,
        audit: parsed.audit ?? base.audit,
        counters: parsed.counters ?? base.counters,
        periods: parsed.periods ?? base.periods,
        costCenters: parsed.costCenters ?? base.costCenters,
        documents: parsed.documents ?? base.documents,
        journals: parsed.journals ?? base.journals,
        stockMovements: parsed.stockMovements ?? base.stockMovements,
        bankStatements: parsed.bankStatements ?? base.bankStatements,
        payrollRecords: parsed.payrollRecords ?? base.payrollRecords,
        checks: parsed.checks ?? base.checks,
        boms: parsed.boms ?? base.boms,
        serials: parsed.serials ?? base.serials,
        organizations: parsed.organizations ?? base.organizations,
        memberships: parsed.memberships ?? base.memberships,
        refreshTokens: parsed.refreshTokens ?? base.refreshTokens,
        recurringEntries: parsed.recurringEntries ?? base.recurringEntries,
        treasuryTransactions: parsed.treasuryTransactions ?? base.treasuryTransactions,
        salesInvoices: parsed.salesInvoices ?? base.salesInvoices,
        purchaseOrders: parsed.purchaseOrders ?? base.purchaseOrders,
        fixedAssets: parsed.fixedAssets ?? base.fixedAssets,
        productionOrders: parsed.productionOrders ?? base.productionOrders,
        taxSubmissions: parsed.taxSubmissions ?? base.taxSubmissions,
        workspaces: parsed.workspaces ?? base.workspaces,
        jwtSecret: parsed.jwtSecret ?? base.jwtSecret,
      };
      cache = database;
      /**
       * اگر کلیدِ امضای توکن را خودِ برنامه ساخته است (JWT_SECRET تنظیم نشده)، آن را
       * درونِ پایگاه داده هم نگه می‌داریم تا با پشتیبان‌ها جابه‌جا شود و با پاک شدنِ
       * فایلِ کلید، نشست‌ها از بین نروند.
       */
      if (!database.jwtSecret && process.env.RAHKAR_GENERATED_SECRET === '1' && process.env.JWT_SECRET) {
        database.jwtSecret = process.env.JWT_SECRET;
        void persist(database);
      }
      ensureOrganizationScaffold(database);
      return database;
    } catch {
      // فایل خراب است: از یک پایگاه خالی شروع می‌کنیم و نسخه‌ی قبلی را نگه می‌داریم
      renameSync(dataFile, `${dataFile}.corrupt-${Date.now()}`);
    }
  }
  const fresh = emptyDatabase();
  if (process.env.RAHKAR_GENERATED_SECRET === '1' && process.env.JWT_SECRET) fresh.jwtSecret = process.env.JWT_SECRET;
  cache = fresh;
  return cache;
}

function persist(database: Database): Promise<void> {
  writeQueue = writeQueue.then(
    () =>
      new Promise<void>((done) => {
        try {
          mkdirSync(dataDirectory, { recursive: true });
          const temporary = `${dataFile}.tmp-${process.pid}-${Date.now()}`;
          writeFileSync(temporary, JSON.stringify(database, null, 2), 'utf8');
          renameSync(temporary, dataFile);
        } catch (error) {
          console.error(`ذخیره‌سازی ناموفق بود: ${(error as Error).message}`);
        }
        done();
      }),
  );
  return writeQueue as Promise<void>;
}

/** اعمال تغییر روی پایگاه و ذخیره‌ی آن؛ نتیجه‌ی تابع تغییر دهنده برگردانده می‌شود */
async function commit<T>(mutate: (database: Database) => T): Promise<T> {
  const database = load();
  const outcome = mutate(database);
  await persist(database);
  return outcome;
}

const seedUsers = (): Array<{ username: string; displayName: string; password: string; role: RoleId }> => [
  { username: 'admin', displayName: 'حسین صادقی', password: 'admin123', role: 'admin' },
  { username: 'hesabdari', displayName: 'مریم احمدی', password: '1234', role: 'accountant' },
  { username: 'foroosh', displayName: 'رضا کریمی', password: '1234', role: 'sales' },
  { username: 'anbar', displayName: 'سارا مرادی', password: '1234', role: 'warehouse' },
];

/** ایجاد کاربران پایه در اولین اجرا */
/** فیلتر بر پایه‌ی شرکت؛ بدون شناسه همه‌ی رکوردها برمی‌گردند (سازگاری با داده‌های قدیمی) */
function byOrganization<T extends { organizationId?: string }>(rows: T[], organizationId?: string): T[] {
  if (!organizationId) return rows;
  return rows.filter((row) => (row.organizationId ?? '') === organizationId);
}

/** کلید شمارنده‌ی اختصاصی هر شرکت تا شماره‌گذاری اسناد مستقل باشد */
function scopedCounterKey(key: string, organizationId?: string): string {
  return organizationId ? `${organizationId}:${key}` : key;
}

export async function seed(): Promise<void> {
  const database = load();
  const hasUsers = database.users.length > 0;
  if (!hasUsers) {
    const now = new Date().toISOString();
    database.users = seedUsers().map((item) => ({
      id: randomUUID(),
      username: item.username,
      displayName: item.displayName,
      passwordHash: hashPassword(item.password),
      role: item.role,
      isActive: true,
      createdAt: now,
    }));
  }
  seedFiscalPeriods(database);
  seedCostCenters(database);
  // داده‌های نمونه پس از داربستِ شرکت ساخته شده‌اند؛ شرکت و عضویتِ آن‌ها تکمیل می‌شود
  ensureOrganizationScaffold(database);
  await persist(database);
  if (!hasUsers) console.log('User seeding complete');
}

const persianMonths = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

/** مراکز هزینه‌ی پایه برای تخصیص هزینه و بودجه */
function seedCostCenters(database: Database): void {
  if (database.costCenters.length) return;
  const definitions = [
    { code: 'CC-1001', title: 'تولید' },
    { code: 'CC-1002', title: 'فروش و بازاریابی' },
    { code: 'CC-1003', title: 'اداری و عمومی' },
    { code: 'CC-1004', title: 'تحقیق و توسعه' },
    { code: 'CC-1005', title: 'پشتیبانی و خدمات پس از فروش' },
  ];
  database.costCenters = definitions.map((item) => ({ id: randomUUID(), code: item.code, title: item.title, isActive: true }));
}

/** دوره‌های ماهانه‌ی سال مالی (نمونه: ۱۴۰۵) با باز/بسته بودن */
function seedFiscalPeriods(database: Database): void {
  if (database.periods.length) return;
  const year = 1405;
  const lengths = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
  let cursor = Date.UTC(2026, 2, 21); // آغاز سال ۱۴۰۵ خورشیدی
  database.periods = persianMonths.map((month, index) => {
    const begins = new Date(cursor);
    const ends = new Date(cursor + (lengths[index] - 1) * 86_400_000);
    cursor = ends.getTime() + 86_400_000;
    return {
      id: randomUUID(),
      year,
      index: index + 1,
      title: `${month} ${year}`,
      startsOn: begins.toISOString().slice(0, 10),
      endsOn: ends.toISOString().slice(0, 10),
      status: index === 5 ? 'باز' : 'بسته',
    } as FiscalPeriod;
  });
}

/* --------------------- فروش، خرید، خزانه، اموال و تولید --------------------- */

/** شناسه‌ی دوره‌ی بازِ سازمان (برای ثبتِ سندِ خودکار) */
function openPeriodId(organizationId: string): string | undefined {
  return load().periods
    .filter((row) => (row.organizationId ?? 'org-default') === organizationId && row.status === 'باز')
    .sort((a, b) => String(b.startsOn).localeCompare(String(a.startsOn)))[0]?.id;
}

export async function listTreasuryTransactions(organizationId?: string): Promise<TreasuryTransactionRecord[]> {
  return byOrganization([...load().treasuryTransactions], organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createTreasuryTransaction(input: {
  organizationId: string; transactionType: 'receipt' | 'payment'; accountTitle: string;
  bankOrCash: string; amount: number; description: string; createdBy?: string;
}): Promise<TreasuryTransactionRecord> {
  if (!['receipt', 'payment'].includes(input.transactionType)) throw new Error('نوع تراکنش نامعتبر است');
  if (!input.accountTitle?.trim() || !input.bankOrCash?.trim() || !input.description?.trim()) throw new Error('طرف حساب، بانک/صندوق و شرح الزامی هستند');
  if (!(input.amount > 0)) throw new Error('مبلغ باید بزرگ‌تر از صفر باشد');
  const amount = Math.round(input.amount);
  const journal = await createJournalEntry({
    organizationId: input.organizationId,
    sourceType: 'treasury',
    description: input.description.trim(),
    periodId: openPeriodId(input.organizationId),
    createdBy: input.createdBy,
    status: 'قطعی',
    lines: input.transactionType === 'receipt'
      ? [{ accountCode: '1100', accountTitle: input.bankOrCash.trim(), debit: amount, credit: 0 }, { accountCode: '1200', accountTitle: input.accountTitle.trim(), debit: 0, credit: amount }]
      : [{ accountCode: '2000', accountTitle: input.accountTitle.trim(), debit: amount, credit: 0 }, { accountCode: '1100', accountTitle: input.bankOrCash.trim(), debit: 0, credit: amount }],
  });
  return commit((database) => {
    const record: TreasuryTransactionRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      transactionType: input.transactionType,
      accountTitle: input.accountTitle.trim(),
      bankOrCash: input.bankOrCash.trim(),
      amount,
      description: input.description.trim(),
      status: 'تأیید شده',
      createdAt: new Date().toISOString(),
      journalId: journal.id,
    };
    database.treasuryTransactions.unshift(record);
    return record;
  });
}

export async function listSalesInvoices(organizationId?: string): Promise<SalesInvoiceRecord[]> {
  return byOrganization([...load().salesInvoices], organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createSalesInvoiceRecord(input: {
  organizationId: string; customerName: string; discount: number; tax: number;
  lines: Array<{ itemTitle: string; quantity: number; unitPrice: number }>; createdBy?: string;
}): Promise<SalesInvoiceRecord> {
  const lines = (input.lines ?? []).filter((line) => line.itemTitle?.trim() && line.quantity > 0 && line.unitPrice >= 0);
  if (!input.customerName?.trim() || !lines.length) throw new Error('مشتری و حداقل یک قلم کالا الزامی است');
  const subtotal = Math.round(lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0));
  const discount = Math.round(Number(input.discount) || 0);
  const tax = Math.round(Number(input.tax) || 0);
  const total = subtotal - discount + tax;
  if (total <= 0) throw new Error('مبلغ فاکتور باید بزرگ‌تر از صفر باشد');
  const journalLines: JournalLine[] = [{ accountCode: '1200', accountTitle: 'حساب‌های دریافتنی', debit: total, credit: 0 }];
  journalLines.push({ accountCode: '4000', accountTitle: 'درآمد فروش', debit: 0, credit: Math.max(0, subtotal - discount) });
  if (tax > 0) journalLines.push({ accountCode: '2300', accountTitle: 'مالیات بر ارزش افزوده', debit: 0, credit: tax });
  const journal = await createJournalEntry({
    organizationId: input.organizationId,
    sourceType: 'sales',
    description: `فاکتور فروش به ${input.customerName.trim()}`,
    periodId: openPeriodId(input.organizationId),
    createdBy: input.createdBy,
    status: 'قطعی',
    lines: journalLines,
  });
  return commit((database) => {
    const number = database.salesInvoices.filter((row) => row.organizationId === input.organizationId).reduce((max, row) => Math.max(max, row.invoiceNumber), 1000) + 1;
    const record: SalesInvoiceRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      invoiceNumber: number,
      customerName: input.customerName.trim(),
      subtotal, discount, tax, total,
      status: 'تأیید شده',
      lines: lines.map((line) => ({ itemTitle: line.itemTitle.trim(), quantity: line.quantity, unitPrice: Math.round(line.unitPrice) })),
      journalId: journal.id,
      createdAt: new Date().toISOString(),
    };
    database.salesInvoices.unshift(record);
    return record;
  });
}

export async function listPurchaseOrders(organizationId?: string): Promise<PurchaseOrderRecord[]> {
  return byOrganization([...load().purchaseOrders], organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createPurchaseOrderRecord(input: {
  organizationId: string; supplierName: string; itemTitle: string;
  quantity: number; unitPrice: number; createdBy?: string;
}): Promise<PurchaseOrderRecord> {
  if (!input.supplierName?.trim() || !input.itemTitle?.trim()) throw new Error('تأمین‌کننده و کالا الزامی هستند');
  if (!(input.quantity > 0) || !(input.unitPrice >= 0)) throw new Error('تعداد و قیمت معتبر الزامی است');
  const total = Math.round(input.quantity * input.unitPrice);
  const journal = await createJournalEntry({
    organizationId: input.organizationId,
    sourceType: 'purchase',
    description: `سفارش خرید ${input.itemTitle.trim()} از ${input.supplierName.trim()}`,
    periodId: openPeriodId(input.organizationId),
    createdBy: input.createdBy,
    status: 'قطعی',
    lines: [
      { accountCode: '5000', accountTitle: 'بهای تمام‌شده کالای فروش‌رفته', debit: total, credit: 0 },
      { accountCode: '2000', accountTitle: 'حساب‌های پرداختنی', debit: 0, credit: total },
    ],
  });
  return commit((database) => {
    const number = database.purchaseOrders.filter((row) => row.organizationId === input.organizationId).reduce((max, row) => Math.max(max, row.orderNumber), 1000) + 1;
    const record: PurchaseOrderRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      orderNumber: number,
      supplierName: input.supplierName.trim(),
      itemTitle: input.itemTitle.trim(),
      quantity: input.quantity,
      unitPrice: Math.round(input.unitPrice),
      total,
      status: 'تأیید شده',
      journalId: journal.id,
      createdAt: new Date().toISOString(),
    };
    database.purchaseOrders.unshift(record);
    return record;
  });
}

export async function listFixedAssets(organizationId?: string): Promise<FixedAssetRecord[]> {
  return byOrganization([...load().fixedAssets], organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createFixedAssetRecord(input: {
  organizationId: string; title: string; location: string; acquisitionCost: number; usefulLifeMonths: number;
}): Promise<FixedAssetRecord> {
  if (!input.title?.trim() || !input.location?.trim()) throw new Error('عنوان و محل استقرار الزامی هستند');
  if (!(input.acquisitionCost > 0)) throw new Error('بهای تمام‌شده باید بزرگ‌تر از صفر باشد');
  if (!(input.usefulLifeMonths > 0)) throw new Error('عمر مفید باید بزرگ‌تر از صفر باشد');
  return commit((database) => {
    const count = database.fixedAssets.filter((row) => row.organizationId === input.organizationId).length + 1;
    const record: FixedAssetRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      assetCode: `FA-${String(count).padStart(4, '0')}`,
      title: input.title.trim(),
      location: input.location.trim(),
      acquisitionCost: Math.round(input.acquisitionCost),
      usefulLifeMonths: Math.round(input.usefulLifeMonths),
      accumulatedDepreciation: 0,
      status: 'فعال',
      createdAt: new Date().toISOString(),
    };
    database.fixedAssets.unshift(record);
    return record;
  });
}

export async function listProductionOrders(organizationId?: string): Promise<ProductionOrderRecord[]> {
  return byOrganization([...load().productionOrders], organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createProductionOrderRecord(input: {
  organizationId: string; productTitle: string; plannedQuantity: number; materialTitle: string;
  materialQuantity: number; unitCost: number; laborCost: number; overheadCost?: number;
}): Promise<ProductionOrderRecord> {
  if (!input.productTitle?.trim() || !input.materialTitle?.trim()) throw new Error('محصول و ماده‌ی اولیه الزامی هستند');
  if (!(input.plannedQuantity > 0) || !(input.materialQuantity > 0)) throw new Error('مقادیر باید بزرگ‌تر از صفر باشند');
  const materialCost = Math.round(input.materialQuantity * (input.unitCost ?? 0));
  const laborCost = Math.round(input.laborCost ?? 0);
  const overhead = Math.round(input.overheadCost ?? 0);
  if (input.unitCost < 0 || laborCost < 0 || overhead < 0) throw new Error('مبالغ نمی‌توانند منفی باشند');
  return commit((database) => {
    const number = database.productionOrders.filter((row) => row.organizationId === input.organizationId).reduce((max, row) => Math.max(max, row.orderNumber), 1000) + 1;
    const record: ProductionOrderRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      orderNumber: number,
      productTitle: input.productTitle.trim(),
      plannedQuantity: input.plannedQuantity,
      materialTitle: input.materialTitle.trim(),
      materialQuantity: input.materialQuantity,
      materialCost,
      laborCost,
      totalCost: materialCost + laborCost + overhead,
      status: 'برنامه‌ریزی‌شده',
      createdAt: new Date().toISOString(),
    };
    database.productionOrders.unshift(record);
    return record;
  });
}

/* ------------------------- اسنادِ تکرارشونده ------------------------- */

export type RecurringInput = {
  title: string;
  debitAccount: string;
  debitTitle: string;
  creditAccount: string;
  creditTitle: string;
  amount: number;
  frequency: 'monthly' | 'quarterly' | 'yearly';
  startDate: string;
};

export async function listRecurring(organizationId?: string): Promise<RecurringEntry[]> {
  const rows = byOrganization([...load().recurringEntries], organizationId);
  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function createRecurring(input: RecurringInput & { organizationId: string }): Promise<RecurringEntry> {
  return commit((database) => {
    if (!input.title?.trim()) throw new Error('عنوانِ سند تکرارشونده الزامی است');
    if (!(input.amount > 0)) throw new Error('مبلغ باید بزرگ‌تر از صفر باشد');
    if (!/^\d{3,10}$/.test(String(input.debitAccount ?? '')) || !/^\d{3,10}$/.test(String(input.creditAccount ?? ''))) throw new Error('کد حساب باید عددی باشد');
    if (String(input.debitAccount) === String(input.creditAccount)) throw new Error('حساب بدهکار و بستانکار نباید یکی باشد');
    const record: RecurringEntry = {
      id: randomUUID(),
      organizationId: input.organizationId,
      title: input.title.trim(),
      debitAccount: String(input.debitAccount),
      debitTitle: String(input.debitTitle ?? '').trim() || 'بدون عنوان',
      creditAccount: String(input.creditAccount),
      creditTitle: String(input.creditTitle ?? '').trim() || 'بدون عنوان',
      amount: input.amount,
      frequency: input.frequency === 'quarterly' || input.frequency === 'yearly' ? input.frequency : 'monthly',
      startDate: String(input.startDate ?? '').slice(0, 10),
      runs: 0,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    database.recurringEntries.push(record);
    return record;
  });
}

export async function deleteRecurring(id: string): Promise<void> {
  await commit((database) => {
    database.recurringEntries = database.recurringEntries.filter((row) => row.id !== id);
  });
}

export async function toggleRecurring(id: string): Promise<RecurringEntry | null> {
  return commit((database) => {
    const record = database.recurringEntries.find((row) => row.id === id);
    if (!record) return null;
    record.isActive = !record.isActive;
    return record;
  });
}

/**
 * صدورِ دستیِ یک سند از روی الگو. بازه‌ی تکرار بررسی نمی‌شود چون تصمیم با کاربر است؛
 * اما اگر ماهِ جاری قبلاً صادر شده باشد، تکراری ساخته نمی‌شود (مگر با force).
 */
export async function runRecurring(id: string, force = false, actor = 'سیستم'): Promise<{ entryId: string; number: number; title: string }> {
  const template = load().recurringEntries.find((row) => row.id === id);
  if (!template) throw new Error('الگوی سند پیدا نشد');
  // برای دوره‌های غیرِ ماهانه، بازه بر اساس ماه‌های سپری‌شده سنجیده می‌شود
  const step = template.frequency === 'yearly' ? 12 : template.frequency === 'quarterly' ? 3 : 1;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthsSince = ((): number => {
    if (!template.lastRun) return step;
    const last = new Date(template.lastRun);
    const now = new Date();
    return (now.getFullYear() - last.getFullYear()) * 12 + (now.getMonth() - last.getMonth());
  })();
  if (!force && monthsSince < step) throw new Error('هنوز نوبتِ صدورِ این سند نرسیده است');
  const period = load().periods
    .filter((row) => (row.organizationId ?? 'org-default') === template.organizationId && row.status === 'باز')
    .sort((a, b) => String(b.startsOn).localeCompare(String(a.startsOn)))[0];
  if (!period) throw new Error('هیچ دوره‌ی مالی بازی برای صدورِ سند وجود ندارد');
  const description = `${template.title} — ${new Intl.DateTimeFormat('fa-IR', { month: 'long', year: 'numeric' }).format(new Date())}`;
  const entry = await createJournalEntry({
    organizationId: template.organizationId,
    sourceType: 'recurring',
    description,
    periodId: period?.id,
    createdBy: actor,
    status: 'پیش‌نویس',
    lines: [
      { accountCode: template.debitAccount, accountTitle: template.debitTitle, debit: template.amount, credit: 0 },
      { accountCode: template.creditAccount, accountTitle: template.creditTitle, debit: 0, credit: template.amount },
    ],
  });
  await commit((database) => {
    const stored = database.recurringEntries.find((row) => row.id === id);
    if (stored) { stored.lastRun = new Date().toISOString(); stored.runs += 1; }
  });
  return { entryId: entry.id, number: entry.number, title: description };
}

/** وضعیتِ ارسالِ صورت‌حساب به سامانه‌ی مودیان */
export type TaxSubmissionRecord = {
  id: string; organizationId: string;
  invoiceNumber: string; invoiceType: string;
  buyerName: string; buyerNationalId?: string;
  totalBeforeVat: number; totalVat: number; totalAmount: number;
  /** وضعیت: در صف / ارسال شد / ناموفق */
  status: 'در صف' | 'ارسال شد' | 'ناموفق';
  attempts: number; lastError?: string;
  /** شناسه‌ی یکتای مالیاتی دریافت‌شده از سامانه */
  referenceId?: string;
  payload: string;
  createdBy?: string; createdAt: string; sentAt?: string;
};

export async function listTaxSubmissions(organizationId?: string): Promise<TaxSubmissionRecord[]> {
  return byOrganization([...load().taxSubmissions], organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTaxSubmission(id: string): Promise<TaxSubmissionRecord | undefined> {
  return load().taxSubmissions.find((row) => row.id === id);
}

export async function createTaxSubmission(input: Omit<TaxSubmissionRecord, 'id' | 'createdAt' | 'status' | 'attempts'>): Promise<TaxSubmissionRecord> {
  const record: TaxSubmissionRecord = {
    ...input,
    id: randomUUID(),
    status: 'در صف',
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  await commit((database) => {
    database.taxSubmissions = database.taxSubmissions.filter(
      (row) => !(row.organizationId === record.organizationId && row.invoiceNumber === record.invoiceNumber && row.status === 'در صف'),
    );
    database.taxSubmissions.unshift(record);
  });
  return record;
}

export async function updateTaxSubmission(
  id: string,
  patch: Partial<Pick<TaxSubmissionRecord, 'status' | 'attempts' | 'lastError' | 'referenceId' | 'sentAt' | 'payload'>>,
): Promise<TaxSubmissionRecord | undefined> {
  let updated: TaxSubmissionRecord | undefined;
  await commit((database) => {
    const row = database.taxSubmissions.find((item) => item.id === id);
    if (!row) return;
    Object.assign(row, patch);
    updated = row;
  });
  return updated;
}

export async function deleteTaxSubmission(id: string): Promise<boolean> {
  let removed = false;
  await commit((database) => {
    const before = database.taxSubmissions.length;
    database.taxSubmissions = database.taxSubmissions.filter((row) => !(row.id === id && row.status !== 'ارسال شد'));
    removed = database.taxSubmissions.length < before;
  });
  return removed;
}

/* ---------------------------------- کاربران ---------------------------------- */

export async function findUser(username: string): Promise<UserRecord | undefined> {
  const normalized = username.trim().toLowerCase();
  return load().users.find((user) => user.username.toLowerCase() === normalized);
}

export async function listUsers(): Promise<Array<Omit<UserRecord, 'passwordHash'>>> {
  return load().users.map(({ passwordHash: _ignored, ...user }) => user);
}

export type CreateUserInput = { username: string; displayName: string; password: string; role: RoleId };

export async function createUser(input: CreateUserInput): Promise<Omit<UserRecord, 'passwordHash'>> {
  return commit((database) => {
    const username = input.username.trim().toLowerCase();
    if (!username || !input.displayName.trim() || !input.password) throw new Error('نام کاربری، نام نمایشی و رمز عبور الزامی هستند');
    if (database.users.some((user) => user.username.toLowerCase() === username)) throw new Error('این نام کاربری قبلاً ثبت شده است');
    const user: UserRecord = {
      id: randomUUID(),
      username,
      displayName: input.displayName.trim(),
      passwordHash: hashPassword(input.password),
      role: input.role,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    database.users.push(user);
    const { passwordHash: _ignored, ...safe } = user;
    return safe;
  });
}

export async function setUserActive(id: string, isActive: boolean): Promise<void> {
  await commit((database) => {
    const user = database.users.find((item) => item.id === id);
    if (!user) throw new Error('کاربر پیدا نشد');
    if (user.username === 'admin' && !isActive) throw new Error('غیرفعال‌کردن مدیر اصلی سیستم مجاز نیست');
    user.isActive = isActive;
  });
}

/* ---------------------------------- رویدادها ---------------------------------- */

export async function listEvents(organizationId?: string): Promise<StoredEvent[]> {
  return byOrganization([...load().events], organizationId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export type CreateEventInput = {
  title: string;
  moduleId: string;
  amount?: number;
  priority?: string;
  status?: string;
    createdBy?: string;
    organizationId?: string;
  };

export async function addEvent(input: CreateEventInput): Promise<StoredEvent> {
  return commit((database) => {
    const event: StoredEvent = {
      id: randomUUID(),
      organizationId: input.organizationId,
      title: String(input.title ?? '').trim(),
      moduleId: String(input.moduleId ?? 'identity'),
      amount: Number(input.amount ?? 0) || 0,
      priority: String(input.priority ?? 'عادی'),
      status: String(input.status ?? 'در انتظار'),
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };
    if (!event.title) throw new Error('عنوان رویداد الزامی است');
    database.events.unshift(event);
    return event;
  });
}

export async function patchEvent(id: string, changes: Partial<StoredEvent>): Promise<StoredEvent | undefined> {
  return commit((database) => {
    const event = database.events.find((item) => item.id === id);
    if (!event) return undefined;
    Object.assign(event, changes);
    return event;
  });
}

/* -------------------------------- شماره‌گذاری -------------------------------- */

/** شماره‌ی بعدی اسناد به تفکیک نوع سند؛ بعد از ری‌استارت ادامه دارد */
export async function nextNumber(key: string, start = 1000, organizationId?: string): Promise<number> {
  return commit((database) => {
    const counterKey = scopedCounterKey(key, organizationId);
    const current = database.counters[counterKey] ?? start;
    const next = current + 1;
    database.counters[counterKey] = next;
    return next;
  });
}

export async function listCounters(): Promise<Record<string, number>> {
  return { ...load().counters };
}

/* --------------------------------- ردیابی عملیات --------------------------------- */

export type AuditInput = { actor: string; action: string; entity: string; entityId?: string; detail?: string };

export async function recordAudit(input: AuditInput): Promise<AuditEntry> {
  return commit((database) => {
    const entry: AuditEntry = { id: randomUUID(), at: new Date().toISOString(), ...input };
    database.audit.unshift(entry);
    if (database.audit.length > 5000) database.audit.length = 5000;
    return entry;
  });
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  return load().audit.slice(0, Math.min(limit, 5000));
}

/* ------------------------------------ آمار ------------------------------------ */

export async function stats(): Promise<{ users: number; events: number; audit: number; pending: number }> {
  const database = load();
  return {
    users: database.users.length,
    events: database.events.length,
    audit: database.audit.length,
    pending: database.events.filter((event) => event.status === 'در انتظار').length,
  };
}
/* ------------------------- سال مالی و مراکز هزینه ------------------------- */

export async function listPeriods(organizationId?: string): Promise<FiscalPeriod[]> {
  return byOrganization([...load().periods], organizationId).sort((left, right) => left.index - right.index);
}

export async function createPeriod(input: { year: number; index: number; title: string; startsOn: string; endsOn: string; organizationId?: string }): Promise<FiscalPeriod> {
  return commit((database) => {
    if (!input.title.trim() || !input.startsOn || !input.endsOn) throw new Error('عنوان و بازه‌ی دوره الزامی است');
    const sameOrg = (row: { organizationId?: string }): boolean => (row.organizationId ?? '') === (input.organizationId ?? '');
    if (byOrganization(database.periods, input.organizationId).some((period) => period.year === input.year && period.index === input.index)) throw new Error('این دوره از قبل تعریف شده است');
    const period: FiscalPeriod = { id: randomUUID(), status: 'باز', ...input, title: input.title.trim() };
    database.periods.push(period);
    return period;
  });
}

export async function setPeriodStatus(id: string, status: 'باز' | 'بسته'): Promise<FiscalPeriod | undefined> {
  return commit((database) => {
    const period = database.periods.find((item) => item.id === id);
    if (!period) return undefined;
    period.status = status;
    return period;
  });
}

/**
 * بستنِ سال مالی:
 *  ۱) حساب‌های موقت (درآمد ۴xxx و هزینه ۵xxx/۶xxx) بسته می‌شوند،
 *  ۲) خالصِ سود یا زیان به حسابِ «سود (زیان) انباشته» (۳۰۰۰) منتقل می‌شود،
 *  ۳) یک سندِ اختتامیه صادر و همه‌ی دوره‌های آن سال بسته می‌شوند.
 */
export type FiscalYearClosing = {
  entryId: string;
  number: number;
  revenue: number;
  expense: number;
  netIncome: number;
  closedPeriods: number;
};

export async function closeFiscalYear(input: { organizationId: string; year: number; actor?: string }): Promise<FiscalYearClosing> {
  const organizationId = input.organizationId;
  const database = load();
  const periods = database.periods.filter((row) => (row.organizationId ?? 'org-default') === organizationId && Number(row.year) === Number(input.year));
  if (!periods.length) throw new Error(`برای سال ${input.year} دوره‌ای تعریف نشده است`);
  if (periods.every((row) => row.status === 'بسته')) throw new Error('این سال مالی قبلاً بسته شده است');

  const periodIds = new Set(periods.map((row) => row.id));
  const entries = database.journals.filter((row) => (row.organizationId ?? 'org-default') === organizationId && (!row.periodId || periodIds.has(row.periodId)));
  const revenue = new Map<string, { code: string; title: string; balance: number }>();
  const expense = new Map<string, { code: string; title: string; balance: number }>();
  entries.forEach((entry) => entry.lines.forEach((line) => {
    const code = String(line.accountCode ?? '');
    if (code.startsWith('4')) {
      const current = revenue.get(code) ?? { code, title: line.accountTitle ?? code, balance: 0 };
      current.balance += (line.credit ?? 0) - (line.debit ?? 0);
      revenue.set(code, current);
    }
    if (code.startsWith('5') || code.startsWith('6')) {
      const current = expense.get(code) ?? { code, title: line.accountTitle ?? code, balance: 0 };
      current.balance += (line.debit ?? 0) - (line.credit ?? 0);
      expense.set(code, current);
    }
  }));
  const totalRevenue = [...revenue.values()].reduce((sum, row) => sum + row.balance, 0);
  const totalExpense = [...expense.values()].reduce((sum, row) => sum + row.balance, 0);
  const netIncome = totalRevenue - totalExpense;
  if (!totalRevenue && !totalExpense) throw new Error('در این سال مالی سندِ درآمد یا هزینه‌ای ثبت نشده است');

  /** سطرهای سندِ اختتامیه: بستنِ درآمدها و هزینه‌ها و انتقالِ خالص به سود انباشته */
  const lines: JournalLine[] = [];
  [...revenue.values()].filter((row) => Math.abs(row.balance) > 0.01).forEach((row) => lines.push({ accountCode: row.code, accountTitle: row.title, debit: Math.max(0, row.balance), credit: Math.max(0, -row.balance) }));
  [...expense.values()].filter((row) => Math.abs(row.balance) > 0.01).forEach((row) => lines.push({ accountCode: row.code, accountTitle: row.title, debit: Math.max(0, -row.balance), credit: Math.max(0, row.balance) }));
  // مانده‌ی نهایی به سود (زیان) انباشته منتقل می‌شود
  lines.push({ accountCode: '3000', accountTitle: 'سود (زیان) انباشته', debit: Math.max(0, -netIncome), credit: Math.max(0, netIncome) });
  const totalDebit = Math.round(lines.reduce((sum, line) => sum + line.debit, 0) * 100) / 100;
  const totalCredit = Math.round(lines.reduce((sum, line) => sum + line.credit, 0) * 100) / 100;
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    // در صورتی که حساب ۳۰۰۰ تعریف نشده باشد یا تفاوتِ گرد کردن وجود داشته باشد
    const diff = Math.round((totalDebit - totalCredit) * 100) / 100;
    const retained = lines.find((line) => line.accountCode === '3000');
    if (retained) { if (diff > 0) retained.credit += diff; else retained.debit += -diff; }
  }

  const entry = await createJournalEntry({
    organizationId,
    sourceType: 'closing',
    description: `سند اختتامیه‌ی سال مالی ${input.year} — انتقال سود و زیان به حساب سود انباشته`,
    status: 'قطعی',
    createdBy: input.actor ?? 'سیستم',
    lines,
  });
  const closedPeriods = await commit((db) => {
    let count = 0;
    db.periods.forEach((row) => {
      if ((row.organizationId ?? 'org-default') === organizationId && Number(row.year) === Number(input.year) && row.status !== 'بسته') {
        row.status = 'بسته';
        count += 1;
      }
    });
    return count;
  });

  return { entryId: entry.id, number: entry.number, revenue: totalRevenue, expense: totalExpense, netIncome, closedPeriods };
}

export async function listCostCenters(organizationId?: string): Promise<CostCenter[]> {
  return byOrganization(load().costCenters, organizationId).filter((center) => center.isActive).sort((left, right) => left.code.localeCompare(right.code));
}

export async function createCostCenter(input: { code: string; title: string; organizationId?: string }): Promise<CostCenter> {
  return commit((database) => {
    const code = input.code.trim();
    if (!code || !input.title.trim()) throw new Error('کد و عنوان مرکز هزینه الزامی است');
    if (byOrganization(database.costCenters, input.organizationId).some((center) => center.code.toLowerCase() === code.toLowerCase())) throw new Error('این کد در این شرکت قبلاً ثبت شده است');
    const center: CostCenter = { id: randomUUID(), code, title: input.title.trim(), isActive: true, organizationId: input.organizationId };
    database.costCenters.push(center);
    return center;
  });
}

/* --------------------------- اسناد و گردش کار --------------------------- */

export type CreateDocumentInput = {
  title: string;
  moduleId: string;
  amount?: number;
  priority?: string;
  periodId?: string;
  costCenterId?: string;
  createdBy?: string;
  organizationId?: string;
};

export async function listDocuments(filter: { moduleId?: string; status?: string; organizationId?: string } = {}): Promise<DocumentRecord[]> {
  return byOrganization(load().documents, filter.organizationId)
    .filter((item) => (!filter.moduleId || item.moduleId === filter.moduleId) && (!filter.status || item.status === filter.status))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function getDocument(id: string): Promise<DocumentRecord | undefined> {
  return load().documents.find((item) => item.id === id);
}

export async function createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
  return commit((database) => {
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('عنوان سند الزامی است');
    const documentKey = scopedCounterKey('document', input.organizationId);
    const number = (database.counters[documentKey] ?? 1000) + 1;
    database.counters[documentKey] = number;
    const now = new Date().toISOString();
    const document: DocumentRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      number,
      title,
      moduleId: input.moduleId || 'identity',
      amount: Number(input.amount ?? 0) || 0,
      priority: input.priority ?? 'عادی',
      status: 'پیش‌نویس',
      history: [{ at: now, actor: input.createdBy ?? 'سیستم', action: 'create', from: '—', to: 'پیش‌نویس' }],
      periodId: input.periodId,
      costCenterId: input.costCenterId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    database.documents.unshift(document);
    return document;
  });
}

export type TransitionInput = { action: string; to: string; actor: string; comment?: string };

export async function transitionDocument(id: string, input: TransitionInput): Promise<DocumentRecord | undefined> {
  return commit((database) => {
    const document = database.documents.find((item) => item.id === id);
    if (!document) return undefined;
    const now = new Date().toISOString();
    document.history.push({ at: now, actor: input.actor, action: input.action, from: document.status, to: input.to, comment: input.comment });
    document.status = input.to;
    document.updatedAt = now;
    return document;
  });
}
/* --------------------------- اسناد حسابداری --------------------------- */

export type CreateJournalInput = {
  sourceType: string;
  description: string;
  lines: JournalLine[];
  sourceId?: string;
  moduleId?: string;
  periodId?: string;
  costCenterId?: string;
  createdBy?: string;
  status?: 'پیش‌نویس' | 'قطعی';
  organizationId?: string;
};

export async function listJournalEntries(filter: { status?: string; moduleId?: string; organizationId?: string } = {}): Promise<JournalEntry[]> {
  return byOrganization(load().journals, filter.organizationId)
    .filter((entry) => (!filter.status || entry.status === filter.status) && (!filter.moduleId || entry.moduleId === filter.moduleId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function createJournalEntry(input: CreateJournalInput): Promise<JournalEntry> {
  return commit((database) => {
    const lines = (input.lines ?? []).map((item) => ({
      accountCode: String(item.accountCode ?? '').trim(),
      accountTitle: String(item.accountTitle ?? '').trim(),
      debit: Number(item.debit) || 0,
      credit: Number(item.credit) || 0,
      ...(item.costCenter ? { costCenter: item.costCenter } : {}),
    }));
    if (lines.length < 2) throw new Error('هر سند باید حداقل دو سطر داشته باشد');
    if (lines.some((item) => !item.accountCode)) throw new Error('کد حساب در همه‌ی سطرها الزامی است');
    const totalDebit = Math.round(lines.reduce((sum, item) => sum + item.debit, 0) * 100) / 100;
    const totalCredit = Math.round(lines.reduce((sum, item) => sum + item.credit, 0) * 100) / 100;
    if (Math.abs(totalDebit - totalCredit) > 0.01) throw new Error(`سند نامتوازن است (بدهکار ${totalDebit}، بستانکار ${totalCredit})`);
    const status = input.status ?? 'پیش‌نویس';
    // ثبتِ سند در دوره‌ی بسته مجاز نیست (به‌جز سندِ اختتامیه که خودِ سیستم می‌سازد)
    const organizationId = input.organizationId ?? 'org-default';
    if (input.sourceType !== 'closing') {
      const periodId = input.periodId;
      const blocked = periodId
        ? database.periods.find((row) => row.id === periodId)?.status === 'بسته'
        : database.periods.filter((row) => (row.organizationId ?? 'org-default') === organizationId).length > 0
          && database.periods.filter((row) => (row.organizationId ?? 'org-default') === organizationId).every((row) => row.status === 'بسته');
      if (blocked) throw new Error('دوره‌ی مالی بسته است؛ ابتدا دوره را بازگشایی کنید');
    }
    const journalKey = scopedCounterKey('journal', input.organizationId);
    const number = (database.counters[journalKey] ?? 1000) + 1;
    database.counters[journalKey] = number;
    const entry: JournalEntry = {
      id: randomUUID(),
      organizationId: input.organizationId,
      number,
      description: String(input.description ?? '').trim() || 'سند حسابداری',
      sourceType: input.sourceType,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.moduleId ? { moduleId: input.moduleId } : {}),
      lines,
      totalDebit,
      totalCredit,
      status,
      ...(input.periodId ? { periodId: input.periodId } : {}),
      ...(input.costCenterId ? { costCenterId: input.costCenterId } : {}),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      ...(status === 'قطعی' ? { postedAt: new Date().toISOString(), postedBy: input.createdBy } : {}),
    };
    database.journals.unshift(entry);
    return entry;
  });
}

export async function postJournalEntry(id: string, actor: string): Promise<JournalEntry | undefined> {
  return commit((database) => {
    const entry = database.journals.find((item) => item.id === id);
    if (!entry) return undefined;
    entry.status = 'قطعی';
    entry.postedAt = new Date().toISOString();
    entry.postedBy = actor;
    return entry;
  });
}

/** تراز آزمایشی بر اساس اسناد قطعی‌شده */
export async function accountBalances(organizationId?: string): Promise<AccountBalance[]> {
  const balances = new Map<string, AccountBalance>();
  for (const entry of byOrganization(load().journals, organizationId)) {
    if (entry.status !== 'قطعی') continue;
    for (const item of entry.lines) {
      const current = balances.get(item.accountCode) ?? { code: item.accountCode, title: item.accountTitle, debit: 0, credit: 0, balance: 0 };
      current.debit = Math.round((current.debit + item.debit) * 100) / 100;
      current.credit = Math.round((current.credit + item.credit) * 100) / 100;
      current.balance = Math.round((current.debit - current.credit) * 100) / 100;
      balances.set(item.accountCode, current);
    }
  }
  return [...balances.values()].sort((left, right) => left.code.localeCompare(right.code));
}

/** خلاصه‌ی وضعیت مالی برای داشبورد */
export async function financialSummary(organizationId?: string): Promise<{ postedEntries: number; draftEntries: number; totalDebit: number; totalCredit: number; balanced: boolean }> {
  const journals = byOrganization(load().journals, organizationId);
  const posted = journals.filter((entry) => entry.status === 'قطعی');
  const totalDebit = Math.round(posted.reduce((sum, entry) => sum + entry.totalDebit, 0) * 100) / 100;
  const totalCredit = Math.round(posted.reduce((sum, entry) => sum + entry.totalCredit, 0) * 100) / 100;
  return {
    postedEntries: posted.length,
    draftEntries: journals.length - posted.length,
    totalDebit,
    totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) < 0.01,
  };
}

/** سطرهای اسناد قطعی به همراه اطلاعات سند؛ مبنای همه‌ی گزارش‌های مالی */
export async function postedLedgerLines(filter: { from?: string; to?: string; organizationId?: string } = {}): Promise<LedgerLine[]> {
  const lines: LedgerLine[] = [];
  for (const entry of byOrganization(load().journals, filter.organizationId)) {
    if (entry.status !== 'قطعی') continue;
    const date = entry.createdAt.slice(0, 10);
    if (filter.from && date < filter.from) continue;
    if (filter.to && date > filter.to) continue;
    for (const item of entry.lines) {
      lines.push({
        entryId: entry.id,
        entryNumber: entry.number,
        date,
        description: entry.description,
        accountCode: item.accountCode,
        accountTitle: item.accountTitle,
        debit: item.debit,
        credit: item.credit,
        costCenter: item.costCenter,
        runningBalance: 0,
        nature: 'بدهکار',
      });
    }
  }
  return lines;
}

export async function balanceSheetReport(filter: { from?: string; to?: string } = {}) {
  return balanceSheet(await postedLedgerLines(filter));
}

export async function profitLossReport(filter: { from?: string; to?: string } = {}) {
  return profitLoss(await postedLedgerLines(filter));
}

export async function generalLedgerReport(filter: { from?: string; to?: string } = {}) {
  return generalLedger(await postedLedgerLines(filter));
}

export async function subsidiaryLedgerReport(accountCode: string, filter: { from?: string; to?: string } = {}) {
  return subsidiaryLedger(await postedLedgerLines(filter), accountCode);
}

/** خلاصه‌ی مالیات بر ارزش افزوده از روی سطرهای حساب ۲۲۰۰ */
export async function vatReport(filter: { from?: string; to?: string } = {}) {
  const lines = (await postedLedgerLines(filter)).filter((item) => item.accountCode === '2200');
  const outputVat = currency(lines.filter((item) => item.credit > 0).reduce((sum, item) => sum + item.credit, 0)); // فروش
  const inputVat = currency(lines.filter((item) => item.debit > 0).reduce((sum, item) => sum + item.debit, 0)); // خرید
  return { outputVat, inputVat, payableVat: currency(outputVat - inputVat), entries: lines.length };
}

/* ===================== انبار و بهای تمام‌شده ===================== */

export async function listStockMovements(itemId?: string, organizationId?: string): Promise<StockMovement[]> {
  const rows = byOrganization(load().stockMovements, organizationId);
  return (itemId ? rows.filter((row) => row.itemId === itemId) : rows).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createStockMovement(input: {
  itemId: string;
  itemTitle: string;
  date?: string;
  type: 'ورود' | 'خروج';
  quantity: number;
  unitCost?: number;
  reference?: string;
    method?: 'wac' | 'fifo';
    organizationId?: string;
  }): Promise<StockMovement> {
  if (!input.itemId?.trim()) throw new Error('کد کالا الزامی است');
  if (!input.itemTitle?.trim()) throw new Error('نام کالا الزامی است');
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('مقدار باید بزرگ‌تر از صفر باشد');
  const method = input.method ?? 'wac';
  const database = load();
  let unitCost = input.unitCost !== undefined ? currency(Number(input.unitCost)) : undefined;
  let costAmount = 0;

  if (input.type === 'ورود') {
    if (unitCost === undefined || Number.isNaN(unitCost) || unitCost < 0) throw new Error('برای ورود کالا، بهای واحد الزامی است');
    costAmount = currency(unitCost * quantity);
  } else {
    const history = database.stockMovements.filter((row) => row.itemId === input.itemId);
    if (method === 'fifo') {
      const result = fifoIssueCost(history, input.itemId, quantity, input.date ?? new Date().toISOString().slice(0, 10));
      if (!result.sufficient) throw new Error('موجودی کالا برای این خروج کافی نیست');
      unitCost = result.unitCost;
      costAmount = result.amount;
    } else {
      const row = wacCosting(history).find((item) => item.itemId === input.itemId);
      const onHand = row?.quantity ?? 0;
      if (onHand < quantity) throw new Error(`موجودی کافی نیست (موجودی: ${onHand})`);
      unitCost = row?.unitCost ?? 0;
      costAmount = currency(unitCost * quantity);
    }
  }

  const movement: StockMovement = {
    id: randomUUID(),
    organizationId: input.organizationId,
    itemId: input.itemId.trim(),
    itemTitle: input.itemTitle.trim(),
    date: input.date ?? new Date().toISOString().slice(0, 10),
    type: input.type,
    quantity: currency(quantity),
    unitCost,
    costAmount,
    reference: input.reference?.trim(),
    method,
    createdAt: new Date().toISOString(),
  };
  database.stockMovements.unshift(movement);
  await persist(load());
  return movement;
}

export async function inventoryCosting(method: 'wac' | 'fifo' = 'wac'): Promise<{
  method: string;
  rows: Array<{ itemId: string; itemTitle: string; quantity: number; unitCost: number; value: number }>;
  totalValue: number;
}> {
  const rows = wacCosting(load().stockMovements);
  const values = rows.map((row) => {
    const value = method === 'fifo'
      ? currency(row.layers.reduce((sum, layer) => sum + layer.quantity * layer.unitCost, 0))
      : row.value;
    return { itemId: row.itemId, itemTitle: row.itemTitle, quantity: row.quantity, unitCost: row.quantity > 0 ? Math.round((value / row.quantity) * 10000) / 10000 : 0, value };
  });
  return { method, rows: values, totalValue: currency(values.reduce((sum, row) => sum + row.value, 0)) };
}

/* ===================== تطبیق بانکی ===================== */

export async function listBankStatements(): Promise<BankStatementRow[]> {
  return load().bankStatements.slice().sort((a, b) => b.date.localeCompare(a.date));
}

export async function createBankStatement(input: {
  date: string;
  description: string;
  reference?: string;
  amount: number;
  direction: 'دریافت' | 'پرداخت';
}): Promise<BankStatementRow> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('مبلغ صورت‌حساب باید بزرگ‌تر از صفر باشد');
  if (!input.date) throw new Error('تاریخ صورت‌حساب الزامی است');
  if (input.direction !== 'دریافت' && input.direction !== 'پرداخت') throw new Error('نوع تراکنش باید دریافت یا پرداخت باشد');
  const row: BankStatementRow = {
    id: randomUUID(),
    date: input.date,
    description: (input.description ?? '').trim() || 'بدون شرح',
    reference: input.reference?.trim(),
    amount: currency(amount),
    direction: input.direction,
    createdAt: new Date().toISOString(),
  };
  load().bankStatements.unshift(row);
  await persist(load());
  return row;
}

/** سطرهای حساب بانک (۱۱۰۰) در اسناد قطعی */
async function bankLedgerLines(): Promise<BankLedgerLine[]> {
  const lines: BankLedgerLine[] = [];
  for (const entry of load().journals) {
    if (entry.status !== 'قطعی') continue;
    for (const item of entry.lines) {
      if (item.accountCode !== '1100') continue;
      if (item.debit > 0) lines.push({ entryId: entry.id, entryNumber: entry.number, date: entry.createdAt.slice(0, 10), description: entry.description, amount: item.debit, direction: 'دریافت' });
      if (item.credit > 0) lines.push({ entryId: entry.id, entryNumber: entry.number, date: entry.createdAt.slice(0, 10), description: entry.description, amount: item.credit, direction: 'پرداخت' });
    }
  }
  return lines;
}

export async function bankReconciliation() {
  return reconcileBank(await listBankStatements(), await bankLedgerLines());
}

export async function matchBankStatement(statementId: string, entryId: string | null): Promise<BankStatementRow | undefined> {
  const database = load();
  const row = database.bankStatements.find((item) => item.id === statementId);
  if (!row) return undefined;
  if (entryId === null) delete row.matchedEntryId;
  else row.matchedEntryId = entryId;
  await persist(load());
  return row;
}

/* ===================== حقوق و دستمزد ===================== */

export async function calculatePayrollFor(input: PayrollInput): Promise<PayrollResult> {
  return calculatePayroll(input);
}

export async function listPayrollRecords(period?: string, organizationId?: string): Promise<PayrollRecord[]> {
  const rows = byOrganization(load().payrollRecords, organizationId);
  return (period ? rows.filter((row) => row.period === period) : rows).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createPayrollRecord(input: {
  period: string;
  personnelCode: string;
  fullName: string;
  payroll: PayrollInput;
  journalId?: string;
    createdBy?: string;
    organizationId?: string;
  }): Promise<PayrollRecord> {
  if (!input.period?.trim()) throw new Error('دوره‌ی حقوق الزامی است');
  if (!input.fullName?.trim()) throw new Error('نام کارمند الزامی است');
  const record: PayrollRecord = {
    id: randomUUID(),
    organizationId: input.organizationId,
    period: input.period.trim(),
    personnelCode: (input.personnelCode ?? '').trim(),
    fullName: input.fullName.trim(),
    input: input.payroll,
    result: calculatePayroll(input.payroll),
    journalId: input.journalId,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  load().payrollRecords.unshift(record);
  await persist(load());
  return record;
}

export async function payrollSummary(period?: string): Promise<ReturnType<typeof summarizePayroll>> {
  const rows = await listPayrollRecords(period);
  return summarizePayroll(rows.map((row) => row.result));
}

export async function attachPayrollJournal(id: string, journalId: string): Promise<PayrollRecord | undefined> {
  const record = load().payrollRecords.find((row) => row.id === id);
  if (!record) return undefined;
  record.journalId = journalId;
  await persist(load());
  return record;
}

/* ===================== چک‌ها ===================== */

export async function listChecks(filter: { direction?: string; status?: string; organizationId?: string } = {}): Promise<CheckRecord[]> {
  return byOrganization(load().checks, filter.organizationId)
    .filter((row) => (!filter.direction || row.direction === filter.direction) && (!filter.status || row.status === filter.status))
    .slice()
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export async function createCheck(input: {
  number: string;
  serial?: string;
  bank: string;
  amount: number;
  issueDate: string;
  dueDate: string;
  direction: 'دریافتنی' | 'پرداختنی';
  party: string;
  description?: string;
    createdBy?: string;
    organizationId?: string;
  }): Promise<CheckRecord> {
  if (!input.number?.trim()) throw new Error('شماره چک الزامی است');
  if (!input.bank?.trim()) throw new Error('نام بانک الزامی است');
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('مبلغ چک باید بزرگ‌تر از صفر باشد');
  if (!input.issueDate || !input.dueDate) throw new Error('تاریخ صدور و سررسید الزامی است');
  if (input.direction !== 'دریافتنی' && input.direction !== 'پرداختنی') throw new Error('نوع چک باید دریافتنی یا پرداختنی باشد');
  const record: CheckRecord = {
    id: randomUUID(),
    organizationId: input.organizationId,
    number: input.number.trim(),
    serial: (input.serial ?? '').trim(),
    bank: input.bank.trim(),
    amount: currency(amount),
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    direction: input.direction,
    party: (input.party ?? '').trim() || 'نامشخص',
    status: 'در جریان وصول',
    description: input.description?.trim(),
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  load().checks.unshift(record);
  await persist(load());
  return record;
}

export async function updateCheckStatus(id: string, status: CheckRecord['status']): Promise<CheckRecord | undefined> {
  const allowed: CheckRecord['status'][] = ['در جریان وصول', 'وصول شده', 'پرداخت شده', 'برگشتی', 'باطل شده'];
  if (!allowed.includes(status)) throw new Error('وضعیت چک معتبر نیست');
  const record = load().checks.find((row) => row.id === id);
  if (!record) return undefined;
  record.status = status;
  await persist(load());
  return record;
}

export async function checksSummary(): Promise<{
  receivable: { count: number; amount: number };
  payable: { count: number; amount: number };
  bounced: { count: number; amount: number };
  dueSoon: { count: number; amount: number };
}> {
  const rows = load().checks;
  const sum = (list: CheckRecord[]): number => currency(list.reduce((total, row) => total + row.amount, 0));
  const open = (row: CheckRecord): boolean => row.status === 'در جریان وصول';
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const receivable = rows.filter((row) => row.direction === 'دریافتنی' && open(row));
  const payable = rows.filter((row) => row.direction === 'پرداختنی' && open(row));
  const bounced = rows.filter((row) => row.status === 'برگشتی');
  const dueSoon = rows.filter((row) => open(row) && row.dueDate >= today && row.dueDate <= week);
  return {
    receivable: { count: receivable.length, amount: sum(receivable) },
    payable: { count: payable.length, amount: sum(payable) },
    bounced: { count: bounced.length, amount: sum(bounced) },
    dueSoon: { count: dueSoon.length, amount: sum(dueSoon) },
  };
}

export async function listBoms(organizationId?: string): Promise<BomRecord[]> {
  return byOrganization(load().boms, organizationId).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createBom(input: Omit<BomRecord, 'id' | 'createdAt'>): Promise<BomRecord> {
  if (!input.product?.trim()) throw new Error('نام محصول الزامی است');
  if (!Array.isArray(input.components) || !input.components.length) throw new Error('حداقل یک ماده/قطعه الزامی است');
  if (!(input.outputQuantity > 0)) throw new Error('مقدار خروجی باید بزرگ‌تر از صفر باشد');
  const record: BomRecord = {
    id: randomUUID(),
    organizationId: input.organizationId,
    code: input.code?.trim() || `BOM-${String(load().boms.length + 1).padStart(4, '0')}`,
    product: input.product.trim(),
    outputQuantity: input.outputQuantity,
    components: input.components.map((component) => ({
      itemId: component.itemId ?? '',
      title: component.title?.trim() || 'بدون عنوان',
      quantity: Math.max(0, Number(component.quantity) || 0),
      unit: component.unit?.trim() || 'عدد',
      unitCost: Math.max(0, Number(component.unitCost) || 0),
      scrapPercent: Math.max(0, Math.min(100, Number(component.scrapPercent) || 0)),
    })),
    laborMinutes: Math.max(0, Number(input.laborMinutes) || 0),
    laborRatePerMinute: Math.max(0, Number(input.laborRatePerMinute) || 0),
    overheadPerUnit: Math.max(0, Number(input.overheadPerUnit) || 0),
    note: input.note?.trim() || '',
    createdAt: new Date().toISOString(),
  };
  const database = load();
  database.boms.unshift(record);
  await persist(database);
  return record;
}

export async function deleteBom(id: string): Promise<boolean> {
  const database = load();
  const before = database.boms.length;
  database.boms = database.boms.filter((row) => row.id !== id);
  if (database.boms.length === before) return false;
  await persist(database);
  return true;
}

export async function findBom(id: string): Promise<BomRecord | null> {
  return load().boms.find((row) => row.id === id) ?? null;
}

export async function listSerials(filter: { itemId?: string; status?: SerialStatus; query?: string; organizationId?: string } = {}): Promise<SerialRecord[]> {
  const query = (filter.query ?? '').trim();
  return byOrganization(load().serials, filter.organizationId)
    .filter((row) =>
      (!filter.itemId || row.itemId === filter.itemId) &&
      (!filter.status || row.status === filter.status) &&
      (!query || row.serial.includes(query) || row.itemTitle.includes(query) || (row.party ?? '').includes(query)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** ثبت گروهی شماره سریال (تولید خودکار با پیشوند و شمارنده) */
export async function createSerials(input: {
  itemId: string; itemTitle: string; warehouse?: string; serials: string[]; note?: string; organizationId?: string;
}): Promise<{ created: SerialRecord[]; duplicates: string[] }> {
  if (!input.itemTitle?.trim()) throw new Error('نام کالا الزامی است');
  const wanted = [...new Set((input.serials ?? []).map((value) => String(value).trim()).filter(Boolean))];
  if (!wanted.length) throw new Error('حداقل یک شماره سریال الزامی است');
  const database = load();
  const existing = new Set(database.serials.map((row) => `${row.itemId}::${row.serial}`));
  const duplicates: string[] = [];
  const created: SerialRecord[] = [];
  const now = new Date().toISOString();
  for (const serial of wanted) {
    if (existing.has(`${input.itemId}::${serial}`)) { duplicates.push(serial); continue; }
    const record: SerialRecord = {
      id: randomUUID(), serial, itemId: input.itemId, itemTitle: input.itemTitle.trim(),
      warehouse: input.warehouse?.trim() || 'انبار اصلی', status: 'موجود در انبار', note: input.note?.trim() || '',
      createdAt: now, updatedAt: now,
      organizationId: input.organizationId,
    };
    created.push(record);
    existing.add(`${input.itemId}::${serial}`);
  }
  if (!created.length) throw new Error('همه‌ی شماره سریال‌ها تکراری هستند');
  database.serials.unshift(...created);
  await persist(database);
  return { created, duplicates };
}

/** تغییر وضعیت یک یا چند شماره سریال (تخصیص، فروش، برگشت، اسقاط) */
export async function updateSerialStatus(input: {
  serialIds: string[]; status: SerialStatus; documentId?: string; party?: string; note?: string;
}): Promise<SerialRecord[]> {
  const valid: SerialStatus[] = ['موجود در انبار', 'تخصیص‌یافته', 'فروخته‌شده', 'برگشتی', 'اسقاط'];
  if (!valid.includes(input.status)) throw new Error('وضعیت سریال معتبر نیست');
  const database = load();
  const now = new Date().toISOString();
  const updated: SerialRecord[] = [];
  for (const row of database.serials) {
    if (!input.serialIds.includes(row.id)) continue;
    row.status = input.status;
    row.documentId = input.status === 'موجود در انبار' ? undefined : input.documentId ?? row.documentId;
    row.party = input.status === 'موجود در انبار' ? undefined : input.party ?? row.party;
    row.note = input.note ?? row.note;
    row.updatedAt = now;
    updated.push(row);
  }
  if (!updated.length) throw new Error('هیچ سریالی با این شناسه یافت نشد');
  await persist(database);
  return updated;
}

export async function serialsSummary(): Promise<{ total: number; byStatus: Record<string, number> }> {
  const rows = load().serials;
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  return { total: rows.length, byStatus };
}

/* --------------------------------- شرکت‌ها و عضویت --------------------------------- */

export async function listOrganizations(): Promise<OrganizationRecord[]> {
  return [...load().organizations].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function findOrganization(id: string): Promise<OrganizationRecord | null> {
  return load().organizations.find((organization) => organization.id === id) ?? null;
}

export type CreateOrganizationInput = {
  name: string;
  code: string;
  nationalId?: string;
  economicCode?: string;
  address?: string;
  phone?: string;
  currency?: string;
  fiscalYearStartMonth?: number;
};

export async function createOrganization(input: CreateOrganizationInput): Promise<OrganizationRecord> {
  return commit((database) => {
    const name = String(input.name ?? '').trim();
    const code = String(input.code ?? '').trim().toUpperCase() || name.slice(0, 3).toUpperCase() || 'ORG';
    if (!name) throw new Error('نام شرکت الزامی است');
    if (database.organizations.some((organization) => organization.name === name)) throw new Error('شرکتی با این نام قبلاً ثبت شده است');
    if (database.organizations.some((organization) => organization.code === code)) throw new Error('این کد برای شرکت دیگری استفاده شده است');
    const organization: OrganizationRecord = {
      id: `org-${randomUUID()}`,
      name,
      code,
      nationalId: input.nationalId?.trim(),
      economicCode: input.economicCode?.trim(),
      address: input.address?.trim(),
      phone: input.phone?.trim(),
      currency: input.currency?.trim() || 'ریال',
      fiscalYearStartMonth: Math.min(12, Math.max(1, Number(input.fiscalYearStartMonth) || 1)),
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    database.organizations.push(organization);
    return organization;
  });
}

export async function updateOrganization(id: string, changes: Partial<CreateOrganizationInput & { isActive: boolean }>): Promise<OrganizationRecord | null> {
  return commit((database) => {
    const organization = database.organizations.find((item) => item.id === id);
    if (!organization) return null;
    if (changes.name !== undefined) organization.name = String(changes.name).trim() || organization.name;
    if (changes.code !== undefined) organization.code = String(changes.code).trim().toUpperCase() || organization.code;
    if (changes.nationalId !== undefined) organization.nationalId = changes.nationalId?.trim();
    if (changes.economicCode !== undefined) organization.economicCode = changes.economicCode?.trim();
    if (changes.address !== undefined) organization.address = changes.address?.trim();
    if (changes.phone !== undefined) organization.phone = changes.phone?.trim();
    if (changes.currency !== undefined) organization.currency = changes.currency?.trim() || organization.currency;
    if (changes.fiscalYearStartMonth !== undefined) organization.fiscalYearStartMonth = Math.min(12, Math.max(1, Number(changes.fiscalYearStartMonth) || 1));
    if (changes.isActive !== undefined) organization.isActive = Boolean(changes.isActive);
    return organization;
  });
}

export type MembershipView = MembershipRecord & { username: string; displayName: string };

export async function listMemberships(organizationId?: string): Promise<MembershipView[]> {
  const database = load();
  return database.memberships
    .filter((row) => !organizationId || row.organizationId === organizationId)
    .map((row) => {
      const user = database.users.find((item) => item.id === row.userId);
      return { ...row, username: user?.username ?? '—', displayName: user?.displayName ?? 'کاربر حذف‌شده' };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'fa'));
}

export async function listUserMemberships(userId: string): Promise<Array<MembershipRecord & { organizationName: string; organizationCode: string }>> {
  const database = load();
  return database.memberships
    .filter((row) => row.userId === userId)
    .map((row) => {
      const organization = database.organizations.find((item) => item.id === row.organizationId);
      return { ...row, organizationName: organization?.name ?? 'شرکت حذف‌شده', organizationCode: organization?.code ?? '—' };
    })
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.createdAt.localeCompare(right.createdAt));
}

export async function addMembership(input: { userId: string; organizationId: string; role: RoleId; isDefault?: boolean }): Promise<MembershipRecord> {
  return commit((database) => {
    const duplicate = database.memberships.find((row) => row.userId === input.userId && row.organizationId === input.organizationId);
    if (duplicate) {
      duplicate.role = input.role;
      return duplicate;
    }
    if (input.isDefault) for (const row of database.memberships) if (row.userId === input.userId) row.isDefault = false;
    const membership: MembershipRecord = {
      id: randomUUID(),
      userId: input.userId,
      organizationId: input.organizationId,
      role: input.role,
      isDefault: input.isDefault ?? !database.memberships.some((row) => row.userId === input.userId),
      createdAt: new Date().toISOString(),
    };
    database.memberships.push(membership);
    return membership;
  });
}

export async function setMembershipRole(id: string, role: RoleId): Promise<MembershipRecord | null> {
  return commit((database) => {
    const membership = database.memberships.find((row) => row.id === id);
    if (!membership) return null;
    membership.role = role;
    return membership;
  });
}

export async function removeMembership(id: string): Promise<boolean> {
  return commit((database) => {
    const index = database.memberships.findIndex((row) => row.id === id);
    if (index < 0) return false;
    const [removed] = database.memberships.splice(index, 1);
    if (removed.isDefault) {
      const next = database.memberships.find((row) => row.userId === removed.userId);
      if (next) next.isDefault = true;
    }
    return true;
  });
}

export async function setDefaultMembership(userId: string, organizationId: string): Promise<boolean> {
  return commit((database) => {
    const memberships = database.memberships.filter((row) => row.userId === userId);
    if (!memberships.some((row) => row.organizationId === organizationId)) return false;
    for (const row of memberships) row.isDefault = row.organizationId === organizationId;
    return true;
  });
}

/** آمار تفکیکیِ هر شرکت برای نمایش در کارتِ انتخاب شرکت */
export async function organizationStats(organizationId: string): Promise<{
  journals: number; documents: number; events: number; checks: number; payrollRecords: number; serials: number; boms: number;
}> {
  const database = load();
  return {
    journals: byOrganization(database.journals, organizationId).length,
    documents: byOrganization(database.documents, organizationId).length,
    events: byOrganization(database.events, organizationId).length,
    checks: byOrganization(database.checks, organizationId).length,
    payrollRecords: byOrganization(database.payrollRecords, organizationId).length,
    serials: byOrganization(database.serials, organizationId).length,
    boms: byOrganization(database.boms, organizationId).length,
  };
}

/** نسخه‌ی همگامِ عضویت‌های کاربر برای استفاده در حلّالِ شرکتِ سرور */
export function snapshotMemberships(userId: string): Array<{ organizationId: string; role: RoleId; isDefault: boolean }> {
  return load()
    .memberships.filter((row) => row.userId === userId)
    .map((row) => ({ organizationId: row.organizationId, role: row.role, isDefault: row.isDefault }))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
}

/* --------------------------- پشتیبان‌گیری و بازگردانی --------------------------- */

export type BackupSnapshot = {
  format: 'aria-erp-backup';
  version: number;
  exportedAt: string;
  organizations: OrganizationRecord[];
  memberships: MembershipRecord[];
  data: Database;
};

/** گرفتن نسخه‌ی کامل از همه‌ی داده‌ها (تمام شرکت‌ها) برای دانلود */
export function exportSnapshot(): BackupSnapshot {
  const database = load();
  return {
    format: 'aria-erp-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    organizations: database.organizations,
    memberships: database.memberships,
    data: database,
  };
}

/** بررسی و بازگردانیِ نسخه‌ی پشتیبان؛ پیش از بازگردانی یک نسخه‌ی امن ذخیره می‌شود */
export async function importSnapshot(snapshot: Partial<BackupSnapshot>): Promise<{
  organizations: number; journals: number; documents: number; checks: number; users: number;
}> {
  const incoming = (snapshot?.data ?? snapshot) as Partial<Database> | undefined;
  if (!incoming || typeof incoming !== 'object') throw new Error('فایل پشتیان معتبر نیست');
  if (!Array.isArray(incoming.journals) && !Array.isArray(incoming.organizations)) {
    throw new Error('ساختار فایل با این نسخه از برنامه سازگار نیست');
  }
  const base = emptyDatabase();
  const database: Database = {
    ...base,
    users: Array.isArray(incoming.users) ? incoming.users : base.users,
    events: Array.isArray(incoming.events) ? incoming.events : base.events,
    audit: Array.isArray(incoming.audit) ? incoming.audit : base.audit,
    counters: incoming.counters ?? base.counters,
    periods: Array.isArray(incoming.periods) ? incoming.periods : base.periods,
    costCenters: Array.isArray(incoming.costCenters) ? incoming.costCenters : base.costCenters,
    documents: Array.isArray(incoming.documents) ? incoming.documents : base.documents,
    journals: Array.isArray(incoming.journals) ? incoming.journals : base.journals,
    stockMovements: Array.isArray(incoming.stockMovements) ? incoming.stockMovements : base.stockMovements,
    bankStatements: Array.isArray(incoming.bankStatements) ? incoming.bankStatements : base.bankStatements,
    payrollRecords: Array.isArray(incoming.payrollRecords) ? incoming.payrollRecords : base.payrollRecords,
    checks: Array.isArray(incoming.checks) ? incoming.checks : base.checks,
    boms: Array.isArray(incoming.boms) ? incoming.boms : base.boms,
    serials: Array.isArray(incoming.serials) ? incoming.serials : base.serials,
    organizations: Array.isArray(incoming.organizations) ? incoming.organizations : (snapshot as BackupSnapshot).organizations ?? base.organizations,
    memberships: Array.isArray(incoming.memberships) ? incoming.memberships : (snapshot as BackupSnapshot).memberships ?? base.memberships,
    workspaces: Array.isArray(incoming.workspaces) ? incoming.workspaces : base.workspaces,
    taxSubmissions: Array.isArray(incoming.taxSubmissions) ? incoming.taxSubmissions : base.taxSubmissions,
    treasuryTransactions: Array.isArray(incoming.treasuryTransactions) ? incoming.treasuryTransactions : base.treasuryTransactions,
    salesInvoices: Array.isArray(incoming.salesInvoices) ? incoming.salesInvoices : base.salesInvoices,
    purchaseOrders: Array.isArray(incoming.purchaseOrders) ? incoming.purchaseOrders : base.purchaseOrders,
    fixedAssets: Array.isArray(incoming.fixedAssets) ? incoming.fixedAssets : base.fixedAssets,
    productionOrders: Array.isArray(incoming.productionOrders) ? incoming.productionOrders : base.productionOrders,
    recurringEntries: Array.isArray(incoming.recurringEntries) ? incoming.recurringEntries : base.recurringEntries,
  };
  ensureOrganizationScaffold(database);

  // نسخه‌ی امن از وضعیت فعلی
  try {
    if (existsSync(dataFile)) copyFileSync(dataFile, `${dataFile}.before-restore-${Date.now()}`);
  } catch { /* اگر کپی ممکن نبود ادامه می‌دهیم */ }

  cache = database;
  await persist(database);
  return {
    organizations: database.organizations.length,
    journals: database.journals.length,
    documents: database.documents.length,
    checks: database.checks.length,
    users: database.users.length,
  };
}

/* ------------------------------ فضای کاری ------------------------------ */

/**
 * فضای کاریِ شرکت: داده‌های ماژول‌های برنامه که پیش‌تر فقط در حافظه‌ی مرورگر
 * نگه داشته می‌شد و با پاک شدنِ مرورگر از بین می‌رفت. اکنون نسخه‌ی مرجع روی
 * سرور است و مرورگر فقط یک نسخه‌ی موقت (کش) دارد.
 */
export async function getWorkspace(organizationId: string): Promise<WorkspaceRecord | undefined> {
  return load().workspaces.find((row) => row.organizationId === organizationId);
}

/** ذخیره‌ی یک یا چند کلید از فضای کاری (کلیدهای دیگر دست‌نخورده می‌مانند) */
export async function saveWorkspaceEntries(organizationId: string, entries: Record<string, unknown>, actor?: string): Promise<WorkspaceRecord> {
  if (!organizationId) throw new Error('شرکتِ فعال مشخص نیست');
  return commit((database) => {
    let record = database.workspaces.find((row) => row.organizationId === organizationId);
    if (!record) {
      record = { organizationId, entries: {}, updatedAt: new Date().toISOString() };
      database.workspaces.push(record);
    }
    for (const [key, value] of Object.entries(entries)) record.entries[key] = value;
    record.updatedAt = new Date().toISOString();
    if (actor) record.updatedBy = actor;
    return record;
  });
}

/* --------------------------- توکن‌های تازه‌سازی --------------------------- */

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** ثبت توکن تازه‌سازیِ جدید (فقط اثر هش‌شده ذخیره می‌شود) */
export function addRefreshToken(input: { userId: string; username: string; token: string; familyId?: string; ttlSeconds: number; fingerprint?: string }): RefreshTokenRecord {
  const now = new Date();
  const record: RefreshTokenRecord = {
    id: randomUUID(),
    userId: input.userId,
    username: input.username,
    tokenHash: sha256(input.token),
    familyId: input.familyId ?? randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
    fingerprint: input.fingerprint,
  };
  load().refreshTokens.push(record);
  return record;
}

export function findRefreshToken(token: string): RefreshTokenRecord | undefined {
  const hash = sha256(token);
  return load().refreshTokens.find((record) => record.tokenHash === hash);
}

/** پاک‌سازی توکن‌های منقضی یا ابطال‌شده‌ی قدیمی */
export function purgeRefreshTokens(): number {
  const now = new Date().toISOString();
  const database = load();
  const before = database.refreshTokens.length;
  database.refreshTokens = database.refreshTokens.filter((record) => record.expiresAt > now);
  const removed = before - database.refreshTokens.length;
  if (removed) void persist(database);
  return removed;
}

/**
 * مصرف توکن تازه‌سازی: هر توکن فقط یک‌بار قابل استفاده است (چرخش).
 * اگر توکنِ قبلاً مصرف‌شده دوباره استفاده شود، یعنی احتمالاً دزدیده شده است؛
 * در این صورت کلِ خانواده‌ی توکن‌ها باطل می‌شود.
 */
export function rotateRefreshToken(token: string, nextToken: string, ttlSeconds: number, graceMs = 0): { record: RefreshTokenRecord; reused: boolean } | null {
  const hash = sha256(token);
  const database = load();
  const record = database.refreshTokens.find((item) => item.tokenHash === hash);
  if (!record) return null;
  /** تلاشِ مجددِ همان توکن در بازه‌ی ارفاق (مثلاً تکرارِ درخواست پس از اختلال شبکه) مجاز است */
  const usedRecently = record.usedAt ? Date.now() - new Date(record.usedAt).getTime() < graceMs : false;
  if (record.revokedAt || (record.usedAt && !usedRecently)) {
    // استفاده‌ی مجدد: تمام توکن‌های این خانواده باطل می‌شوند
    const family = record.familyId;
    for (const item of database.refreshTokens) {
      if (item.familyId === family && !item.revokedAt) {
        item.revokedAt = new Date().toISOString();
        item.revokeReason = 'استفاده‌ی مجدد از توکن';
      }
    }
    void persist(database);
    return { record, reused: true };
  }
  record.usedAt = new Date().toISOString();
  const created = addRefreshToken({ userId: record.userId, username: record.username, token: nextToken, familyId: record.familyId, ttlSeconds });
  void persist(database);
  return { record: created, reused: false };
}

/**
 * تازه‌سازیِ نشست با چرخشِ توکن — سازگار با دنیای واقعی:
 *
 * در دنیای واقعی چند رخدادِ کاملاً عادی باعث می‌شود یک توکنِ تازه‌سازیِ «قبلاً مصرف‌شده»
 * دوباره به سرور برسد: چند تبِ باز، دکمه‌ی برگشت/جلو، تکرارِ درخواست پس از اختلال شبکه،
 * یا درخواستی که پیش از تازه‌سازی فرستاده شده و پاسخش دیر رسیده است.
 * پیش از این، هر کدام از این‌ها به‌عنوان «سرقتِ توکن» شناسایی می‌شد و کلِ نشستِ کاربر
 * (همه‌ی تب‌ها) باطل می‌گشت — همان چیزی که کاربر به‌صورت «نشست مدام منقضی می‌شود» می‌دید.
 *
 * رفتارِ تازه:
 *  - توکنِ مصرف‌نشده   → چرخش و صدور توکنِ جدید (مانند قبل)
 *  - توکنِ مصرف‌شده    → اگر از همان دستگاه/مرورگر باشد (اثر یکسان) در بازه‌ی ارفاق،
 *                        همان خانواده ادامه می‌یابد و توکنِ جاری خانواده برگردانده می‌شود؛
 *                        هیچ نشستی باطل نمی‌شود.
 *  - توکنِ مصرف‌شده از دستگاهی دیگر یا پس از پایانِ بازه‌ی ارفاق → نشانه‌ی سرقت؛
 *                        کلِ خانواده باطل و در لاگ ثبت می‌شود.
 */
/** بخشِ نشانیِ اثرِ دستگاه (نخستین بخش پیش از |) برای مقایسه‌ی شبکه‌ی کاربر */
function ipOf(fingerprint?: string): string {
  return String(fingerprint ?? '').split('|')[0] ?? '';
}

export type RefreshOutcome =
  | { status: 'ok'; token: string; username: string; userId: string; reused: boolean }
  | { status: 'invalid' }
  | { status: 'reuse'; username?: string };

export function rotateSessionToken(input: {
  presented: string;
  fingerprint?: string;
  ttlSeconds: number;
  /** سازنده‌ی توکنِ تازه (سرور توکنِ امضاشده می‌سازد) */
  issueToken: () => string;
  /** بازه‌ی ارفاق برای استفاده‌ی دوباره از همان دستگاه (پیش‌فرض ۱۵ دقیقه) */
  graceMs?: number;
}): RefreshOutcome {
  const graceMs = input.graceMs ?? 15 * 60 * 1000;
  const hash = sha256(input.presented);
  const database = load();
  const record = database.refreshTokens.find((item) => item.tokenHash === hash);
  if (!record) return { status: 'invalid' };
  const now = Date.now();
  if (record.revokedAt || new Date(record.expiresAt).getTime() <= now) return { status: 'invalid' };

  /** آخرین توکنِ زنده‌ی خانواده (همان که دستگاهِ کاربر باید داشته باشد) */
  const familyActive = () => database.refreshTokens
    .filter((item) => item.familyId === record.familyId && !item.revokedAt && !item.usedAt && new Date(item.expiresAt).getTime() > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  /** صدور توکنِ تازه برای خانواده؛ رشته‌ی توکن فقط همین‌جا و فقط یک‌بار در دسترس است */
  const issue = (source: RefreshTokenRecord): string => {
    source.usedAt = new Date().toISOString();
    const token = input.issueToken();
    addRefreshToken({
      userId: source.userId,
      username: source.username,
      token,
      familyId: source.familyId,
      ttlSeconds: input.ttlSeconds,
      fingerprint: input.fingerprint ?? source.fingerprint,
    });
    void persist(database);
    return token;
  };

  // حالتِ عادی: توکن هنوز مصرف نشده است
  if (!record.usedAt) {
    return { status: 'ok', token: issue(record), username: record.username, userId: record.userId, reused: false };
  }

  /**
   * توکن مصرف شده است. دو حالتِ کاملاً متفاوت دارد:
   * الف) در بازه‌ی ارفاق (مثلاً ۱۵ دقیقه): این رخداد در زندگی واقعی بسیار عادی است —
   *     چند تبِ باز، دکمه‌ی برگشت، تکرارِ درخواست پس از قطعیِ لحظه‌ایِ شبکه.
   *     خانواده را ادامه می‌دهیم و هیچ نشستی باطل نمی‌شود.
   * ب) پس از بازه‌ی ارفاق: توکن کهنه است. برای حفظِ نشستِ زنده‌ی کاربر خانواده را باطل
   *     نمی‌کنیم؛ فقط همین درخواست رد می‌شود. تنها اگر نشانیِ دستگاه تفاوتِ آشکاری
   *     داشته باشد (نشانه‌ی قویِ سرقت)، کل خانواده باطل می‌گردد.
   */
  const withinGrace = now - new Date(record.usedAt).getTime() < graceMs;
  if (withinGrace) {
    const active = familyActive();
    return { status: 'ok', token: active ? issue(active) : issue(record), username: record.username, userId: record.userId, reused: true };
  }

  const sameNetwork = ipOf(record.fingerprint) === ipOf(input.fingerprint) || !ipOf(record.fingerprint) || !ipOf(input.fingerprint);
  if (!sameNetwork) {
    const family = record.familyId;
    for (const item of database.refreshTokens) {
      if (item.familyId === family && !item.revokedAt) {
        item.revokedAt = new Date().toISOString();
        item.revokeReason = 'استفاده‌ی غیرمجاز (دستگاه یا شبکه‌ی دیگر)';
      }
    }
    void persist(database);
    return { status: 'reuse', username: record.username };
  }
  return { status: 'invalid' };
}

/** ابطال یک توکن (خروج از سیستم) */
export function revokeRefreshToken(token: string): boolean {
  const hash = sha256(token);
  const database = load();
  const record = database.refreshTokens.find((item) => item.tokenHash === hash);
  if (!record || record.revokedAt) return false;
  record.revokedAt = new Date().toISOString();
  record.revokeReason = 'خروج کاربر';
  void persist(database);
  return true;
}

/** ابطال همه‌ی نشست‌های یک کاربر (خروج از همه‌ی دستگاه‌ها) */
export function revokeUserRefreshTokens(userId: string): number {
  const database = load();
  let count = 0;
  for (const record of database.refreshTokens) {
    if (record.userId === userId && !record.revokedAt) {
      record.revokedAt = new Date().toISOString();
      record.revokeReason = 'خروج از همه‌ی دستگاه‌ها';
      count += 1;
    }
  }
  if (count) void persist(database);
  return count;
}

/** ذخیره‌ی تغییرات توکن‌های تازه‌سازی روی دیسک */
export async function persistRefreshTokens(): Promise<void> {
  await persist(load());
}

/** ابطالِ همه‌ی توکن‌های یک خانواده (نشست‌های یک دستگاه/جریان ورود) */
export function revokeRefreshFamily(familyId: string, reason = 'ابطال خانواده'): number {
  const database = load();
  let count = 0;
  for (const record of database.refreshTokens) {
    if (record.familyId === familyId && !record.revokedAt) {
      record.revokedAt = new Date().toISOString();
      record.revokeReason = reason;
      count += 1;
    }
  }
  if (count) void persist(database);
  return count;
}

/** ثبت زمان آخرین ورود کاربر */
export function setUserLastLogin(userId: string): void {
  const database = load();
  const user = database.users.find((item) => item.id === userId);
  if (!user) return;
  (user as UserRecord & { lastLoginAt?: string }).lastLoginAt = new Date().toISOString();
  void persist(database);
}
