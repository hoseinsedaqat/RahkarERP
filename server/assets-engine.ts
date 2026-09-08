/**
 * موتور استهلاک دارایی‌های ثابت
 * ---------------------------------
 * سه روش استاندارد حسابداری ایران:
 *  - straight-line   : خط مستقیم (یکنواخت در طول عمر مفید)
 *  - declining       : نزولی (درصد ثابت از مانده‌ی دفتریِ اولِ دوره)
 *  - sum-of-years    : مجموع سنوات (سال‌های عمر؛ در سال‌های نخست سنگین‌تر)
 *
 * خروجی موتور شامل زمان‌بندی هر دارایی، جمع دوره و سند حسابداریِ آماده‌ی صدور است
 * (بدهکار: هزینه استهلاک ۶۲۰۰ / بستانکار: استهلاک انباشته ۱۵۰۱).
 */

export type DepreciationMethod = 'straight-line' | 'declining' | 'sum-of-years';

export type DepreciableAsset = {
  id: string;
  assetCode: string;
  title: string;
  acquisitionCost: number;
  salvageValue?: number;
  usefulLifeMonths: number;
  accumulatedDepreciation?: number;
  /** درصد نزولی (فقط روش declining)؛ پیش‌فرض ۲ برابر نرخ خط مستقیم */
  decliningRate?: number;
  status?: string;
};

export type DepreciationLine = {
  assetId: string;
  assetCode: string;
  title: string;
  acquisitionCost: number;
  depreciableBase: number;
  elapsedMonths: number;
  remainingMonths: number;
  monthlyAmount: number;
  /** استهلاکِ این دوره (یک ماه) با در نظر گرفتن سقف مانده‌ی قابل استهلاک */
  periodAmount: number;
  accumulatedBefore: number;
  accumulatedAfter: number;
  bookValueBefore: number;
  bookValueAfter: number;
  finished: boolean;
};

export type DepreciationRun = {
  method: DepreciationMethod;
  methodTitle: string;
  periodLabel: string;
  totalMonthly: number;
  totalAccumulated: number;
  totalBookValue: number;
  assetCount: number;
  finishedCount: number;
  lines: DepreciationLine[];
  journal: { description: string; lines: Array<{ accountCode: string; accountTitle: string; debit: number; credit: number; description?: string }> };
};

export const DEPRECIATION_METHODS: Array<{ id: DepreciationMethod; title: string; note: string }> = [
  { id: 'straight-line', title: 'خط مستقیم', note: 'تقسیم یکنواخت بهای قابل استهلاک بر عمر مفید' },
  { id: 'declining', title: 'نزولی', note: 'درصد ثابت از مانده‌ی دفتری؛ استهلاک سال‌های نخست بیشتر است' },
  { id: 'sum-of-years', title: 'مجموع سنوات', note: 'سهم هر سال بر اساس سنوات باقیمانده؛ مطابق الگوی متداول مالیاتی' },
];

const round = (value: number): number => Math.round(value);
const clampNonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** مانده‌ی قابل استهلاک یک دارایی */
export function depreciableBase(asset: DepreciableAsset): number {
  const salvage = clampNonNegative(asset.salvageValue ?? 0);
  return Math.max(0, clampNonNegative(asset.acquisitionCost) - salvage);
}

/** ماه‌های سپری‌شده بر اساس استهلاک انباشته‌ی فعلی (برای دارایی‌های در جریان) */
function elapsedMonths(asset: DepreciableAsset, monthlyStraight: number): number {
  if (monthlyStraight <= 0) return 0;
  const elapsed = Math.round(clampNonNegative(asset.accumulatedDepreciation ?? 0) / monthlyStraight);
  return Math.min(asset.usefulLifeMonths, Math.max(0, elapsed));
}

/** نرخ ماهانه‌ی روش خط مستقیم */
function straightMonthly(asset: DepreciableAsset): number {
  const life = asset.usefulLifeMonths > 0 ? asset.usefulLifeMonths : 1;
  return depreciableBase(asset) / life;
}

/**
 * مبلغ استهلاکِ یک ماه برای دارایی، در شماره‌ی ماهِ داده‌شده از عمر دارایی (۱ تا عمر مفید).
 * در روش نزولی، نرخ به‌صورت درصدی از مانده‌ی دفتریِ ابتدای دوره است.
 */
export function monthAmount(asset: DepreciableAsset, method: DepreciationMethod, monthIndex: number): number {
  const base = depreciableBase(asset);
  const life = asset.usefulLifeMonths > 0 ? asset.usefulLifeMonths : 1;
  if (base <= 0) return 0;
  const index = Math.min(Math.max(1, monthIndex), life);

  if (method === 'straight-line') return base / life;

  if (method === 'declining') {
    const yearlyRate = asset.decliningRate ?? Math.min(0.95, 2 / Math.max(1, life / 12));
    const monthlyRate = yearlyRate / 12;
    const openingBookValue = base * Math.pow(1 - monthlyRate, index - 1);
    const amount = openingBookValue * monthlyRate;
    // در پایان عمر، مانده تا سقف پایه مستهلک می‌شود
    return index >= life ? Math.max(amount, openingBookValue) : amount;
  }

  // مجموع سنوات: مجموعِ سنوات = n(n+1)/2 بر حسب ماه
  const total = (life * (life + 1)) / 2;
  const remaining = life - index + 1;
  return (base * remaining) / total;
}

/** محاسبه‌ی استهلاک یک دوره (ماه) برای فهرستی از دارایی‌ها */
export function depreciationRun(assets: DepreciableAsset[], method: DepreciationMethod = 'straight-line', periodLabel = 'دوره جاری'): DepreciationRun {
  const lines: DepreciationLine[] = assets.map((asset) => {
    const base = depreciableBase(asset);
    const life = asset.usefulLifeMonths > 0 ? asset.usefulLifeMonths : 1;
    const accumulatedBefore = Math.min(base, clampNonNegative(asset.accumulatedDepreciation ?? 0));
    const elapsed = Math.min(life, elapsedMonths(asset, straightMonthly(asset) || 1));
    const remainingMonths = Math.max(0, life - elapsed);
    const bookValueBefore = Math.max(0, clampNonNegative(asset.acquisitionCost) - accumulatedBefore);
    const finished = remainingMonths <= 0 || accumulatedBefore >= base - 1;

    const rawAmount = finished ? 0 : monthAmount(asset, method, elapsed + 1);
    // سقف استهلاک: مانده‌ی قابل استهلاک باقیمانده
    const periodAmount = round(Math.min(rawAmount, Math.max(0, base - accumulatedBefore)));
    const accumulatedAfter = accumulatedBefore + periodAmount;

    return {
      assetId: asset.id,
      assetCode: asset.assetCode,
      title: asset.title,
      acquisitionCost: round(clampNonNegative(asset.acquisitionCost)),
      depreciableBase: round(base),
      elapsedMonths: elapsed,
      remainingMonths,
      monthlyAmount: round(rawAmount),
      periodAmount,
      accumulatedBefore: round(accumulatedBefore),
      accumulatedAfter: round(accumulatedAfter),
      bookValueBefore: round(bookValueBefore),
      bookValueAfter: round(Math.max(0, bookValueBefore - periodAmount)),
      finished,
    };
  });

  const totalMonthly = lines.reduce((sum, line) => sum + line.periodAmount, 0);
  const totalAccumulated = lines.reduce((sum, line) => sum + line.accumulatedAfter, 0);
  const totalBookValue = lines.reduce((sum, line) => sum + line.bookValueAfter, 0);

  return {
    method,
    methodTitle: DEPRECIATION_METHODS.find((item) => item.id === method)?.title ?? 'خط مستقیم',
    periodLabel,
    totalMonthly,
    totalAccumulated,
    totalBookValue,
    assetCount: lines.length,
    finishedCount: lines.filter((line) => line.finished).length,
    lines,
    journal: {
      description: `سند استهلاک ${periodLabel} (${DEPRECIATION_METHODS.find((item) => item.id === method)?.title ?? ''})`,
      lines: totalMonthly > 0
        ? [
            { accountCode: '6200', accountTitle: 'هزینه استهلاک', debit: totalMonthly, credit: 0, description: `استهلاک ${periodLabel}` },
            { accountCode: '1501', accountTitle: 'استهلاک انباشته', debit: 0, credit: totalMonthly, description: `استهلاک ${periodLabel}` },
          ]
        : [],
    },
  };
}

/** زمان‌بندی کامل استهلاک یک دارایی تا پایان عمر مفید (برای پیش‌نمایش نموداری) */
export function depreciationSchedule(asset: DepreciableAsset, method: DepreciationMethod = 'straight-line'): Array<{ month: number; amount: number; accumulated: number; bookValue: number }> {
  const life = asset.usefulLifeMonths > 0 ? asset.usefulLifeMonths : 1;
  const base = depreciableBase(asset);
  let accumulated = clampNonNegative(asset.accumulatedDepreciation ?? 0);
  const schedule: Array<{ month: number; amount: number; accumulated: number; bookValue: number }> = [];
  for (let month = 1; month <= life; month += 1) {
    const remainingBase = Math.max(0, base - accumulated);
    const amount = round(Math.min(monthAmount(asset, method, month), remainingBase));
    accumulated += amount;
    schedule.push({ month, amount, accumulated: round(accumulated), bookValue: round(Math.max(0, clampNonNegative(asset.acquisitionCost) - accumulated)) });
    if (remainingBase - amount <= 0) break;
  }
  return schedule;
}
