/**
 * موتور حقوق و دستمزد — بر اساس قانون کار و مالیات‌های مستقیم ایران
 *
 * نکته‌ی مهم: نرخ‌ها و سقف‌ها هر سال با بخشنامه مزد و قانون بودجه تغییر می‌کنند.
 * مقادیر زیر به‌صورت «پارامتر قابل تنظیم» تعریف شده‌اند تا با ابلاغ سالانه
 * به‌روزرسانی شوند (بدون نیاز به تغییر در منطق برنامه).
 */

export type PayrollSettings = {
  /** حداقل مزد روزانه (ریال) */
  minimumDailyWage: number;
  /** حداقل حقوق پایه ماهانه (ریال) */
  minimumMonthlyWage: number;
  /** حق مسکن ماهانه (ریال) */
  housingAllowance: number;
  /** بن/کمک‌هزینه خواربار ماهانه (ریال) */
  foodAllowance: number;
  /** حق اولاد برای هر فرزند (ریال) */
  childAllowancePerChild: number;
  /** پایه سنوات ماهانه برای هر سال خدمت (ریال) */
  seniorityMonthlyBase: number;
  /** سهم بیمه کارمند (درصد) */
  insuranceEmployeeRate: number;
  /** سهم بیمه کارفرما (درصد) */
  insuranceEmployerRate: number;
  /** معافیت مالیاتی ماهانه (ریال) */
  monthlyTaxExemption: number;
  /** پلکان‌های مالیات حقوق: سقف به صورت «برابر معافیت ماهانه» و نرخ */
  taxBrackets: Array<{ upToMultiple: number; rate: number }>;
  /** تعداد روزهای عیدی پرداختی (قانون: حداقل ۶۰ روز) */
  eidDays: number;
  /** سقف عیدی بر اساس حداقل مزد (قانون: حداکثر ۹۰ روز حداقل مزد روزانه) */
  eidMaxDays: number;
};

/** مقادیر پیش‌فرض — باید با بخشنامه سال جاری تطبیق داده شود */
export const defaultPayrollSettings: PayrollSettings = {
  minimumDailyWage: 3_000_000,
  minimumMonthlyWage: 90_000_000,
  housingAllowance: 9_000_000,
  foodAllowance: 14_000_000,
  childAllowancePerChild: 9_000_000,
  seniorityMonthlyBase: 2_000_000,
  insuranceEmployeeRate: 0.07,
  insuranceEmployerRate: 0.23,
  monthlyTaxExemption: 20_000_000,
  taxBrackets: [
    { upToMultiple: 1, rate: 0 },
    { upToMultiple: 2, rate: 0.1 },
    { upToMultiple: 3, rate: 0.15 },
    { upToMultiple: 4, rate: 0.2 },
    { upToMultiple: Number.POSITIVE_INFINITY, rate: 0.25 },
  ],
  eidDays: 60,
  eidMaxDays: 90,
};

export type PayrollInput = {
  personnelCode?: string;
  fullName?: string;
  /** حقوق پایه ماهانه */
  baseSalary: number;
  /** فوق‌العاده‌ها و مزایای مشمول بیمه */
  benefits?: number;
  /** تعداد فرزندان مشمول حق اولاد */
  childrenCount?: number;
  /** سنوات خدمت (سال) */
  seniorityYears?: number;
  /** تعداد ساعات اضافه‌کاری */
  overtimeHours?: number;
  /** نرخ ساعت اضافه‌کاری (ریال) */
  overtimeRate?: number;
  /** پاداش و مزایای غیرمشمول مالیات */
  taxFreeBenefits?: number;
  /** کسورات متفرقه (مساعده، وام و …) */
  otherDeductions?: number;
  /** تعداد روزهای کارکرد */
  workingDays?: number;
};

export type PayrollResult = {
  /** حقوق پایه */
  baseSalary: number;
  /** مزایای قانونی (مسکن، خواربار، اولاد، سنوات) */
  allowances: number;
  /** اضافه‌کاری */
  overtime: number;
  /** ناخالص دریافتی */
  gross: number;
  /** مبلغ مشمول بیمه */
  insuranceBase: number;
  /** سهم بیمه کارمند */
  insuranceEmployee: number;
  /** سهم بیمه کارفرما */
  insuranceEmployer: number;
  /** مبلغ مشمول مالیات */
  taxableIncome: number;
  /** مالیات حقوق */
  incomeTax: number;
  /** کسورات متفرقه */
  otherDeductions: number;
  /** خالص پرداختی */
  netPay: number;
  /** هزینه‌ی تمام‌شده برای کارفرما */
  employerCost: number;
  /** ذخیره عیدی (معادل روزانه × روزهای مجاز) */
  eidProvision: number;
  /** ذخیره سنوات پایان کار */
  seniorityProvision: number;
  settings: PayrollSettings;
};

const currency = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

/** مالیات پلکانی حقوق بر اساس معافیت ماهانه و پلکان‌های تنظیم‌شده */
export function incomeTaxOf(taxable: number, settings: PayrollSettings = defaultPayrollSettings): number {
  const exemption = settings.monthlyTaxExemption;
  if (taxable <= exemption) return 0;
  let tax = 0;
  let lower = 0;
  for (const bracket of settings.taxBrackets) {
    const upper = bracket.upToMultiple === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : exemption * bracket.upToMultiple;
    if (taxable <= lower) break;
    const slice = Math.min(taxable, upper) - lower;
    if (slice > 0) tax += slice * bracket.rate;
    lower = upper;
    if (upper === Number.POSITIVE_INFINITY) break;
  }
  return currency(tax);
}

export function calculatePayroll(input: PayrollInput, settings: PayrollSettings = defaultPayrollSettings): PayrollResult {
  const baseSalary = currency(Math.max(input.baseSalary, 0));
  const children = Math.max(0, Math.floor(input.childrenCount ?? 0));
  const seniorityYears = Math.max(0, Number(input.seniorityYears ?? 0));
  const overtimeHours = Math.max(0, Number(input.overtimeHours ?? 0));
  const overtimeRate = currency(Math.max(input.overtimeRate ?? 0, 0));
  const taxFree = currency(Math.max(input.taxFreeBenefits ?? 0, 0));

  const allowances = currency(
    settings.housingAllowance +
      settings.foodAllowance +
      children * settings.childAllowancePerChild +
      (seniorityYears >= 1 ? settings.seniorityMonthlyBase * Math.min(seniorityYears, 30) : 0),
  );
  const overtime = currency(overtimeHours * overtimeRate);
  const benefits = currency(Math.max(input.benefits ?? 0, 0));
  const gross = currency(baseSalary + allowances + benefits + overtime);

  // مبنای بیمه: حقوق پایه + مزایای مشمول (بدون مزایای غیرنقدی)
  const insuranceBase = currency(baseSalary + benefits + overtime);
  const insuranceEmployee = currency(insuranceBase * settings.insuranceEmployeeRate);
  const insuranceEmployer = currency(insuranceBase * settings.insuranceEmployerRate);

  // مبلغ مشمول مالیات: ناخالص منهای کسور بیمه کارمند و مزایای معاف
  const otherDeductions = currency(Math.max(input.otherDeductions ?? 0, 0));
  const taxableIncome = currency(Math.max(gross - insuranceEmployee - taxFree, 0));
  const incomeTax = incomeTaxOf(taxableIncome, settings);

  const netPay = currency(gross - insuranceEmployee - incomeTax - otherDeductions);
  const employerCost = currency(gross + insuranceEmployer);

  // عیدی: مزد روزانه × روزهای پرداختی، با سقف «۹۰ روز حداقل مزد روزانه»
  const dailyWage = Math.max(baseSalary / 30, settings.minimumDailyWage);
  const eidProvision = currency(Math.min(dailyWage * settings.eidDays, settings.minimumDailyWage * settings.eidMaxDays));
  // سنوات: یک ماه حقوق به ازای هر سال خدمت
  const seniorityProvision = currency(Math.max(baseSalary, settings.minimumMonthlyWage) * seniorityYears);

  return {
    baseSalary,
    allowances,
    overtime,
    gross,
    insuranceBase,
    insuranceEmployee,
    insuranceEmployer,
    taxableIncome,
    incomeTax,
    otherDeductions,
    netPay,
    employerCost,
    eidProvision,
    seniorityProvision,
    settings,
  };
}

/** خلاصه‌ی یک دوره برای چند کارمند */
export function summarizePayroll(results: PayrollResult[]): {
  count: number;
  gross: number;
  netPay: number;
  insuranceEmployee: number;
  insuranceEmployer: number;
  incomeTax: number;
  employerCost: number;
} {
  return {
    count: results.length,
    gross: currency(results.reduce((sum, item) => sum + item.gross, 0)),
    netPay: currency(results.reduce((sum, item) => sum + item.netPay, 0)),
    insuranceEmployee: currency(results.reduce((sum, item) => sum + item.insuranceEmployee, 0)),
    insuranceEmployer: currency(results.reduce((sum, item) => sum + item.insuranceEmployer, 0)),
    incomeTax: currency(results.reduce((sum, item) => sum + item.incomeTax, 0)),
    employerCost: currency(results.reduce((sum, item) => sum + item.employerCost, 0)),
  };
}
