/**
 * موتور صدور سند حسابداری
 *
 * هر عملیات مالی (فروش، خرید، حقوق، خزانه، استهلاک، تولید) با یک «قاعده» به
 * سند حسابداری استاندارد تبدیل می‌شود. نتیجه همیشه باید متوازن باشد
 * (جمع بدهکار = جمع بستانکار) و این موضوع در تست‌ها بررسی می‌شود.
 */

export type PostingSource = 'sales' | 'purchase' | 'payroll' | 'treasury-receipt' | 'treasury-payment' | 'depreciation' | 'production';

export type JournalLineDraft = { accountCode: string; accountTitle: string; debit: number; credit: number; costCenter?: string };

export type JournalDraft = { sourceType: PostingSource; description: string; lines: JournalLineDraft[]; totalDebit: number; totalCredit: number; balanced: boolean };

/** حساب‌های پایه‌ی سیستم؛ با داده‌های درج‌شده در seed.ts هماهنگ است */
export const baseAccounts = {
  bank: { code: '1100', title: 'بانک و صندوق' },
  receivable: { code: '1200', title: 'حساب‌های دریافتنی' },
  inventory: { code: '1300', title: 'موجودی مواد و کالا' },
  workInProgress: { code: '1400', title: 'کالای در جریان ساخت' },
  fixedAsset: { code: '1500', title: 'دارایی‌های ثابت' },
  accumulatedDepreciation: { code: '1501', title: 'استهلاک انباشته' },
  payable: { code: '2000', title: 'حساب‌های پرداختنی' },
  salaryPayable: { code: '2100', title: 'حقوق و دستمزد پرداختنی' },
  vat: { code: '2200', title: 'مالیات بر ارزش افزوده' },
  revenue: { code: '4000', title: 'درآمد فروش' },
  costOfGoodsSold: { code: '5000', title: 'بهای تمام‌شده کالای فروش‌رفته' },
  adminExpense: { code: '6000', title: 'هزینه‌های اداری و عمومی' },
  salaryExpense: { code: '6100', title: 'هزینه حقوق و دستمزد' },
  depreciationExpense: { code: '6200', title: 'هزینه استهلاک' },
} as const;

/** نوع هر حساب؛ مبنای ترازنامه و سود و زیان */
export type AccountKind = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export const accountKinds: Record<string, AccountKind> = {
  '1100': 'asset', '1200': 'asset', '1300': 'asset', '1400': 'asset', '1500': 'asset', '1501': 'asset',
  '2000': 'liability', '2100': 'liability', '2200': 'liability',
  '3000': 'equity',
  '4000': 'revenue',
  '5000': 'expense', '6000': 'expense', '6100': 'expense', '6200': 'expense',
};

/** حساب‌های دارایی و هزینه مانده‌ی بدهکار دارند؛ بدهی، حقوق صاحب سرمایه و درآمد بستانکار */
export const isDebitNature = (accountCode: string): boolean => {
  // استهلاک انباشته هم دارایی است (ماهیت بدهکار) اما چون مانده‌اش بستانکار است،
  // در ترازنامه با علامت منفی و در دفتر کل با عنوان «بستانکار» نمایش داده می‌شود
  const kind = accountKinds[accountCode] ?? 'asset';
  return kind === 'asset' || kind === 'expense';
};

export const kindTitle: Record<AccountKind, string> = {
  asset: 'دارایی‌ها',
  liability: 'بدهی‌ها',
  equity: 'حقوق صاحب سرمایه',
  revenue: 'درآمدها',
  expense: 'هزینه‌ها',
};

/** نرخ مالیات بر ارزش افزوده؛ مبلغ سند شامل مالیات است */
export const VAT_RATE = 0.09;
export const vatOf = (amount: number): number => currency((Number(amount) || 0) * VAT_RATE / (1 + VAT_RATE));
export const currency = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

type Line = JournalLineDraft;
const line = (account: { code: string; title: string }, debit: number, credit: number, costCenter?: string): Line => ({
  accountCode: account.code,
  accountTitle: account.title,
  debit: currency(debit),
  credit: currency(credit),
  ...(costCenter ? { costCenter } : {}),
});

type RuleInput = { amount: number; tax?: number; description?: string; costCenter?: string };

/** قواعد صدور سند: هر منبع مالی → سطرهای بدهکار/بستانکار استاندارد */
const rules: Record<PostingSource, (input: RuleInput) => { description: string; lines: Line[] }> = {
  sales: ({ amount, tax = 0, description, costCenter }) => ({
    description: description ?? 'فاکتور فروش',
    lines: [
      line(baseAccounts.receivable, amount, 0, costCenter),
      line(baseAccounts.revenue, 0, currency(amount - tax), costCenter),
      ...(tax > 0 ? [line(baseAccounts.vat, 0, tax)] : []),
    ],
  }),
  purchase: ({ amount, tax = 0, description, costCenter }) => ({
    description: description ?? 'خرید مواد و کالا',
    lines: [
      line(baseAccounts.inventory, currency(amount - tax), 0, costCenter),
      ...(tax > 0 ? [line(baseAccounts.vat, tax, 0)] : []),
      line(baseAccounts.payable, 0, amount, costCenter),
    ],
  }),
  payroll: ({ amount, description, costCenter }) => ({
    description: description ?? 'حقوق و دستمزد دوره',
    lines: [line(baseAccounts.salaryExpense, amount, 0, costCenter), line(baseAccounts.salaryPayable, 0, amount)],
  }),
  'treasury-receipt': ({ amount, description, costCenter }) => ({
    description: description ?? 'دریافت نقدی',
    lines: [line(baseAccounts.bank, amount, 0, costCenter), line(baseAccounts.receivable, 0, amount, costCenter)],
  }),
  'treasury-payment': ({ amount, description, costCenter }) => ({
    description: description ?? 'پرداخت نقدی',
    lines: [line(baseAccounts.payable, amount, 0, costCenter), line(baseAccounts.bank, 0, amount)],
  }),
  depreciation: ({ amount, description, costCenter }) => ({
    description: description ?? 'هزینه استهلاک دوره',
    lines: [line(baseAccounts.depreciationExpense, amount, 0, costCenter), line(baseAccounts.accumulatedDepreciation, 0, amount)],
  }),
  production: ({ amount, description, costCenter }) => ({
    description: description ?? 'تخصیص مواد به تولید',
    lines: [line(baseAccounts.workInProgress, amount, 0, costCenter), line(baseAccounts.inventory, 0, amount, costCenter)],
  }),
};

export const postingSources = Object.keys(rules) as PostingSource[];

export const isPostingSource = (value: unknown): value is PostingSource => typeof value === 'string' && postingSources.includes(value as PostingSource);

/** نگاشت ماژول‌ها به منبع مالی متناظر، برای صدور خودکار هنگام قطعی‌شدن سند */
export const sourceByModule: Record<string, PostingSource> = {
  sales: 'sales',
  purchasing: 'purchase',
  payroll: 'payroll',
  'fixed-assets': 'depreciation',
  manufacturing: 'production',
  inventory: 'production',
  treasury: 'treasury-receipt',
};

/** ساخت سند حسابداری از یک عملیات؛ خروجی شامل بررسی توازن است */
export function buildJournal(input: { sourceType: PostingSource; amount: number; tax?: number; description?: string; costCenter?: string }): JournalDraft {
  const amount = currency(input.amount);
  if (!isPostingSource(input.sourceType)) throw new Error(`نوع عملیات «${input.sourceType}» تعریف نشده است`);
  if (amount <= 0) throw new Error('مبلغ سند باید بزرگ‌تر از صفر باشد');
  const rule = rules[input.sourceType];
  const { description, lines } = rule({ amount, tax: input.tax, description: input.description, costCenter: input.costCenter });
  const totalDebit = currency(lines.reduce((sum, item) => sum + item.debit, 0));
  const totalCredit = currency(lines.reduce((sum, item) => sum + item.credit, 0));
  return { sourceType: input.sourceType, description, lines, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}


/* ===================== گزارش‌های مالی ===================== */

export type Movement = {
  accountCode: string;
  accountTitle: string;
  kind: AccountKind;
  debit: number;
  credit: number;
  balance: number;      // مانده به طبیعت حساب (مثبت = بدهکار برای دارایی و هزینه)
  nature: 'بدهکار' | 'بستانکار';
};

export type LedgerLine = {
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  accountCode: string;
  accountTitle: string;
  debit: number;
  credit: number;
  costCenter?: string;
  runningBalance: number;
  nature: 'بدهکار' | 'بستانکار';
};

/** مبلغ با علامت: اگر مانده خلاف طبیعت حساب باشد، منفی نمایش داده می‌شود */
export function signedAmount(row: Movement): number {
  const expected = isDebitNature(row.accountCode) ? 'بدهکار' : 'بستانکار';
  return row.nature === expected ? row.balance : -row.balance;
}
export type ReportLine = { accountCode: string; accountTitle: string; amount: number };

/** حرکت هر حساب بر اساس سطرهای اسناد قطعی */
export function movements(postedLines: Array<LedgerLine>): Movement[] {
  const map = new Map<string, Movement>();
  for (const item of postedLines) {
    const current = map.get(item.accountCode) ?? {
      accountCode: item.accountCode,
      accountTitle: item.accountTitle,
      kind: (accountKinds[item.accountCode] ?? 'asset') as AccountKind,
      debit: 0,
      credit: 0,
      balance: 0,
      nature: 'بدهکار' as const,
    };
    current.debit = currency(current.debit + item.debit);
    current.credit = currency(current.credit + item.credit);
    // مانده با علامتِ طبیعت حساب: برای حساب‌های بدهکار «بدهکار − بستانکار» و برای بستانکار برعکس
    const signed = currency(isDebitNature(item.accountCode) ? current.debit - current.credit : current.credit - current.debit);
    const debitNature = isDebitNature(item.accountCode);
    current.balance = Math.abs(signed);
    current.nature = signed >= 0 ? (debitNature ? 'بدهکار' : 'بستانکار') : debitNature ? 'بستانکار' : 'بدهکار';
    map.set(item.accountCode, current);
  }
  return [...map.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

/** ترازنامه: دارایی‌ها = بدهی‌ها + حقوق صاحب سرمایه (شامل سود دوره) */
export function balanceSheet(postedLines: Array<LedgerLine>): {
  assets: ReportLine[];
  liabilities: ReportLine[];
  equity: ReportLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  netIncome: number;
  balanced: boolean;
} {
  const rows = movements(postedLines);
  const pick = (kind: AccountKind): ReportLine[] =>
    rows.filter((row) => row.kind === kind && Math.abs(row.balance) > 0.004)
      .map((row) => ({ accountCode: row.accountCode, accountTitle: row.accountTitle, amount: signedAmount(row) }));
  const income = profitLoss(postedLines).netIncome;
  const equity = pick('equity');
  // سود دوره با علامت مثبت و زیان با علامت منفی در حقوق صاحب سرمایه می‌آید
  if (Math.abs(income) > 0.004) equity.push({ accountCode: '3999', accountTitle: 'سود (زیان) خالص دوره', amount: income });
  const totalAssets = currency(pick('asset').reduce((sum, row) => sum + row.amount, 0));
  const totalLiabilities = currency(pick('liability').reduce((sum, row) => sum + row.amount, 0));
  const totalEquity = currency(equity.reduce((sum, row) => sum + row.amount, 0));
  return {
    assets: pick('asset'),
    liabilities: pick('liability'),
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    netIncome: income,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.005,
  };
}

/** سود و زیان: درآمدها منهای هزینه‌ها */
export function profitLoss(postedLines: Array<LedgerLine>): {
  revenues: ReportLine[];
  expenses: ReportLine[];
  totalRevenue: number;
  totalExpense: number;
  netIncome: number;
} {
  const rows = movements(postedLines);
  const pick = (kind: AccountKind): ReportLine[] =>
    rows.filter((row) => row.kind === kind && Math.abs(row.balance) > 0.004)
      .map((row) => ({ accountCode: row.accountCode, accountTitle: row.accountTitle, amount: signedAmount(row) }));
  const revenues = pick('revenue');
  const expenses = pick('expense');
  const totalRevenue = currency(revenues.reduce((sum, row) => sum + row.amount, 0));
  const totalExpense = currency(expenses.reduce((sum, row) => sum + row.amount, 0));
  return { revenues, expenses, totalRevenue, totalExpense, netIncome: currency(totalRevenue - totalExpense) };
}

/** دفتر کل: مانده‌ی هر حساب به تفکیک بدهکار/بستانکار */
export function generalLedger(postedLines: Array<LedgerLine>): Movement[] {
  return movements(postedLines);
}

/** دفتر معین: گردش یک حساب با مانده‌ی روندی */
export function subsidiaryLedger(postedLines: Array<LedgerLine>, accountCode: string): { accountTitle: string; lines: LedgerLine[]; debit: number; credit: number; balance: number; nature: 'بدهکار' | 'بستانکار' } {
  const related = postedLines.filter((item) => item.accountCode === accountCode);
  let running = 0;
  const lines = related.map((item) => {
    running = currency(running + (isDebitNature(accountCode) ? 1 : -1) * (item.debit - item.credit));
    return { ...item, runningBalance: Math.abs(running), nature: running >= 0 ? 'بدهکار' as const : 'بستانکار' as const };
  });
  const debit = currency(related.reduce((sum, item) => sum + item.debit, 0));
  const credit = currency(related.reduce((sum, item) => sum + item.credit, 0));
  const balance = Math.abs(running);
  return {
    accountTitle: related[0]?.accountTitle ?? '',
    lines,
    debit,
    credit,
    balance,
    nature: running >= 0 ? 'بدهکار' : 'بستانکار',
  };
}
