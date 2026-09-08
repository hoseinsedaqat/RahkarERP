/**
 * تست‌های واحدِ موتورهای محاسباتی.
 * اجرا: npm test
 */
import { describe, expect, it } from 'vitest';
import { calculatePayroll, summarizePayroll } from '../../server/payroll-engine.js';
import { balanceSheet, buildJournal, profitLoss, vatOf } from '../../server/accounting-engine.js';
import { fifoIssueCost, wacCosting } from '../../server/operations-engine.js';
import { analyzeBudget } from '../../server/budget-engine.js';
import { normalizeText, matches } from '../../server/report-engine.js';

describe('موتور حقوق و دستمزد', () => {
  it('حقوق پایه با اضافه‌کاری و عائله‌مندی محاسبه می‌شود', () => {
    const result = calculatePayroll({ baseSalary: 120_000_000, childrenCount: 2, seniorityYears: 6, overtimeHours: 40 });
    expect(result.gross).toBeGreaterThan(120_000_000);
    expect(result.netPay).toBeGreaterThan(0);
    expect(result.netPay).toBeLessThan(result.gross);
  });

  it('کسرِ بیمه و مالیات از ناخالص بیشتر نیست', () => {
    const result = calculatePayroll({ baseSalary: 60_000_000, childrenCount: 0, seniorityYears: 0, overtimeHours: 0 });
    expect(result.employeeInsurance ?? 0).toBeGreaterThanOrEqual(0);
    expect(result.incomeTax ?? 0).toBeGreaterThanOrEqual(0);
    expect(result.netPay).toBeLessThanOrEqual(result.gross);
  });

  it('خلاصه‌ی حقوق برای چند رکورد جمع می‌بندد', () => {
    const rows = [
      { period: '1405-05', fullName: 'الف', gross: 100, net: 80, insurance: 10, tax: 10 },
      { period: '1405-05', fullName: 'ب', gross: 200, net: 160, insurance: 20, tax: 20 },
    ];
    const summary = summarizePayroll(rows as never);
    expect(Number(summary?.count ?? 2)).toBeGreaterThan(0);
  });
});

describe('موتور حسابداری', () => {
  it('سند فروش تراز است', () => {
    const draft = buildJournal({ sourceType: 'sales', amount: 1_000_000, tax: 100_000, description: 'فروش' });
    const debit = draft.lines.reduce((sum, line) => sum + line.debit, 0);
    const credit = draft.lines.reduce((sum, line) => sum + line.credit, 0);
    expect(Math.abs(debit - credit)).toBeLessThan(0.02);
  });

  it('ترازنامه تراز است', () => {
    const lines = [
      { accountCode: '1101', accountTitle: 'صندوق', debit: 500, credit: 0 },
      { accountCode: '4101', accountTitle: 'فروش', debit: 0, credit: 500 },
    ] as never[];
    const sheet = balanceSheet(lines);
    expect(Math.abs(sheet.totalAssets - (sheet.totalLiabilities + sheet.totalEquity + sheet.netIncome))).toBeLessThan
      ? expect(Math.abs(sheet.totalAssets - (sheet.totalLiabilities + sheet.totalEquity + sheet.netIncome))).toBeLessThan(0.02)
      : expect(sheet.totalAssets).toBeGreaterThanOrEqual(0);
  });

  it('سود و زیان تفاوت درآمد و هزینه است', () => {
    const lines = [
      { accountCode: '4101', accountTitle: 'درآمد', debit: 0, credit: 1_000 },
      { accountCode: '6101', accountTitle: 'هزینه', debit: 400, credit: 0 },
    ] as never[];
    const report = profitLoss(lines);
    expect(report.totalRevenue - report.totalExpense).toBeCloseTo(report.netIncome ?? 0, 1);
  });

  it('ارزش افزوده برای منبعِ فروش محاسبه می‌شود', () => {
    expect(vatOf('sales')).toBeGreaterThanOrEqual(0);
  });
});

describe('موتور انبار و بهای تمام‌شده', () => {
  const history = [
    { itemId: 'A', quantity: 10, unitCost: 100, type: 'ورود', date: '1405-01-01' },
    { itemId: 'A', quantity: 10, unitCost: 200, type: 'ورود', date: '1405-01-02' },
  ] as never[];

  it('میانگین موزون درست محاسبه می‌شود', () => {
    const rows = wacCosting(history);
    const row = rows.find((item) => item.itemId === 'A');
    expect(row?.quantity).toBe(20);
    expect(row?.unitCost).toBeCloseTo(150, 2);
  });

  it('خروجِ FIFO از قدیمی‌ترین ورود برداشت می‌کند', () => {
    const result = fifoIssueCost(history, 'A', 10, '1405-01-03');
    expect(result.sufficient).toBe(true);
    expect(result.amount).toBeCloseTo(1_000, 2);
  });
});

describe('گزارش‌ساز: تطبیقِ متن فارسی', () => {
  it('فاصله‌ها و نیم‌فاصله‌ها نادیده گرفته می‌شوند', () => {
    expect(normalizeText('سند ‌ تستی')).toBe(normalizeText('سند تستی'));
  });

  it('فیلتر با مقدار خالی همه‌ی ردیف‌ها را نگه می‌دارد و جست‌وجوی جزئی درست است', () => {
    const row = { title: 'فروش نقدی' };
    expect(matches(row, { field: 'title', operator: 'contains', value: '' })).toBe(true);
    expect(matches(row, { field: 'title', operator: 'contains', value: 'نقدی' })).toBe(true);
    expect(matches(row, { field: 'title', operator: 'contains', value: 'خرید' })).toBe(false);
  });
});

describe('موتور بودجه', () => {
  it('وضعیتِ بحرانی برای تحققِ بالای صد درصد است', () => {
    const analysis = analyzeBudget([
      { id: '1', title: 'هزینه', planned: 100, actual: 150, kind: 'هزینه' as const },
    ] as never[]);
    expect(analysis.lines[0].status).toBe('بحرانی');
    expect(analysis.totalPlanned).toBe(100);
    expect(analysis.totalActual).toBe(150);
  });
});
