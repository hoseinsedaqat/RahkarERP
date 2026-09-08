/**
 * موتور تحلیل بودجه و انحراف
 * --------------------------
 * هر ردیف بودجه شامل مبلغ مصوب (planned) و مبلغ تحقق‌یافته (actual) است.
 * موتور برای هر ردیف و در سطح کل محاسبه می‌کند:
 *   انحراف مبلغی و درصدی، درصد تحقق، وضعیت (مطلوب/هشدار/بحرانی)
 * و هشدارهای مدیریتی را برای ردیف‌های خارج از آستانه صادر می‌کند.
 */

export type BudgetLineInput = {
  id?: string;
  title: string;
  /** مبلغ مصوب بودجه */
  planned: number;
  /** مبلغ تحقق‌یافته (عملکرد واقعی) */
  actual: number;
  /** کد حساب مرتبط (برای تطبیق خودکار با دفتر کل) */
  accountCode?: string;
  /** مرکز هزینه */
  costCenter?: string;
  /** دوره بودجه */
  period?: string;
  /** برای هزینه‌ها افزایش نسبت به بودجه نامطلوب است و برای درآمدها برعکس */
  kind?: 'هزینه' | 'درآمد';
};

export type BudgetLineAnalysis = {
  id: string;
  title: string;
  accountCode: string;
  costCenter: string;
  period: string;
  kind: 'هزینه' | 'درآمد';
  planned: number;
  actual: number;
  variance: number;
  variancePercent: number;
  executionPercent: number;
  status: 'مطلوب' | 'هشدار' | 'بحرانی';
  note: string;
};

export type BudgetAnalysis = {
  totalPlanned: number;
  totalActual: number;
  totalVariance: number;
  totalVariancePercent: number;
  executionPercent: number;
  lines: BudgetLineAnalysis[];
  alerts: Array<{ title: string; message: string; severity: 'warning' | 'critical' }>;
  byCostCenter: Array<{ costCenter: string; planned: number; actual: number; variance: number; executionPercent: number }>;
  generatedAt: string;
};

const round = (value: number): number => Math.round(value);
const safe = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * تحلیل بودجه.
 * @param warningThreshold درصد تحققِ بالاتر از آن هشدار (پیش‌فرض ۹۰٪ برای هزینه)
 * @param criticalThreshold درصد تحققِ بالاتر از آن بحرانی (پیش‌فرض ۱۰۰٪)
 */
export function analyzeBudget(
  lines: BudgetLineInput[],
  options: { warningThreshold?: number; criticalThreshold?: number } = {},
): BudgetAnalysis {
  const warning = options.warningThreshold ?? 90;
  const critical = options.criticalThreshold ?? 100;

  const analysed: BudgetLineAnalysis[] = (lines ?? []).map((line, index) => {
    const planned = Math.max(0, safe(Number(line.planned)));
    const actual = safe(Number(line.actual));
    const kind: 'هزینه' | 'درآمد' = line.kind === 'درآمد' ? 'درآمد' : 'هزینه';
    const variance = actual - planned;
    const variancePercent = planned > 0 ? (variance / planned) * 100 : 0;
    const executionPercent = planned > 0 ? (actual / planned) * 100 : 0;
    // برای هزینه، تحققِ بیشتر از بودجه نامطلوب است؛ برای درآمد برعکس
    const pressure = kind === 'هزینه' ? executionPercent : planned > 0 ? (planned / Math.max(1, actual)) * 100 : 0;
    const status: BudgetLineAnalysis['status'] = pressure >= critical ? 'بحرانی' : pressure >= warning ? 'هشدار' : 'مطلوب';
    const note =
      status === 'بحرانی'
        ? kind === 'هزینه' ? 'هزینه از سقف مصوب عبور کرده است' : 'درآمد کمتر از هدف مصوب است'
        : status === 'هشدار'
          ? kind === 'هزینه' ? 'نزدیک به سقف بودجه' : 'درآمد نزدیک به آستانه‌ی هدف است'
          : 'در محدوده‌ی برنامه';
    return {
      id: line.id ?? `budget-${index + 1}`,
      title: String(line.title ?? '').trim() || `ردیف ${index + 1}`,
      accountCode: String(line.accountCode ?? '').trim(),
      costCenter: String(line.costCenter ?? '').trim() || 'عمومی',
      period: String(line.period ?? '').trim(),
      kind,
      planned: round(planned),
      actual: round(actual),
      variance: round(variance),
      variancePercent: Number(variancePercent.toFixed(1)),
      executionPercent: Number(executionPercent.toFixed(1)),
      status,
      note,
    };
  });

  const totalPlanned = round(analysed.reduce((sum, line) => sum + line.planned, 0));
  const totalActual = round(analysed.reduce((sum, line) => sum + line.actual, 0));
  const totalVariance = totalActual - totalPlanned;
  const totalVariancePercent = totalPlanned > 0 ? Number(((totalVariance / totalPlanned) * 100).toFixed(1)) : 0;

  const alerts = analysed
    .filter((line) => line.status !== 'مطلوب')
    .map((line) => ({
      title: line.title,
      message: `${line.note} — تحقق ${line.executionPercent}% (انحراف ${line.variance.toLocaleString('fa-IR')} ریال)`,
      severity: line.status === 'بحرانی' ? ('critical' as const) : ('warning' as const),
    }));

  const centers = new Map<string, { costCenter: string; planned: number; actual: number }>();
  for (const line of analysed) {
    const current = centers.get(line.costCenter) ?? { costCenter: line.costCenter, planned: 0, actual: 0 };
    current.planned += line.planned;
    current.actual += line.actual;
    centers.set(line.costCenter, current);
  }

  return {
    totalPlanned,
    totalActual,
    totalVariance: round(totalVariance),
    totalVariancePercent,
    executionPercent: totalPlanned > 0 ? Number(((totalActual / totalPlanned) * 100).toFixed(1)) : 0,
    lines: analysed,
    alerts,
    byCostCenter: [...centers.values()].map((center) => ({
      costCenter: center.costCenter,
      planned: round(center.planned),
      actual: round(center.actual),
      variance: round(center.actual - center.planned),
      executionPercent: center.planned > 0 ? Number(((center.actual / center.planned) * 100).toFixed(1)) : 0,
    })),
    generatedAt: new Date().toISOString(),
  };
}

/** تطبیق خودکار عملکرد واقعیِ هر ردیف با مانده‌ی حساب‌های دفتر کل */
export function applyActualFromAccounts(
  lines: BudgetLineInput[],
  balances: Array<{ code: string; balance: number }>,
): BudgetLineInput[] {
  const byCode = new Map(balances.map((row) => [String(row.code), safe(row.balance)]));
  return lines.map((line) => {
    const code = String(line.accountCode ?? '').trim();
    if (!code) return line;
    const balance = byCode.get(code);
    if (balance === undefined) return line;
    return { ...line, actual: Math.abs(balance) };
  });
}
