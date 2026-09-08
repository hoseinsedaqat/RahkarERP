/**
 * درگاهِ ارتباط با سامانه‌ی مؤدیان (صورت‌حساب الکترونیکی).
 *
 * اصلِ امنیتی: کلید و شناسه‌ی حافظه‌ی مالیاتی هرگز در پایگاه داده یا در کد ذخیره نمی‌شوند؛
 * فقط از متغیرهای محیطیِ خودِ شما (فایلِ .env) خوانده می‌شوند. اگر تنظیم نباشد،
 * ارسال انجام نمی‌شود و پیامِ روشن به کاربر برمی‌گردد.
 *
 * متغیرها:
 *   TAX_API_URL        نشانیِ سرویسِ ارسال (مثلاً https://tp.tax.gov.ir/...)
 *   TAX_API_KEY        کلید/توکنِ دریافتی از کارپوشه‌ی مؤدیان
 *   TAX_FISCAL_ID      شناسه‌ی یکتای حافظه‌ی مالیاتی
 *   TAX_NATIONAL_ID    شناسه‌ی ملیِ فروشنده
 *   TAX_ECONOMIC_CODE  کدِ اقتصادی (اختیاری)
 */

export type TaxGatewaySettings = {
  configured: boolean;
  endpoint?: string;
  fiscalId?: string;
  nationalId?: string;
  /** فهرستِ مواردی که هنوز تنظیم نشده‌اند */
  missing: string[];
};

const required: Array<{ key: string; env: string; label: string }> = [
  { key: 'endpoint', env: 'TAX_API_URL', label: 'نشانیِ سرویس (TAX_API_URL)' },
  { key: 'apiKey', env: 'TAX_API_KEY', label: 'کلیدِ اتصال (TAX_API_KEY)' },
  { key: 'fiscalId', env: 'TAX_FISCAL_ID', label: 'شناسه‌ی حافظه‌ی مالیاتی (TAX_FISCAL_ID)' },
  { key: 'nationalId', env: 'TAX_NATIONAL_ID', label: 'شناسه‌ی ملیِ فروشنده (TAX_NATIONAL_ID)' },
];

function read(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

/** تنظیمات را می‌خواند بی‌آنکه کلید را فاش کند */
export function taxSettings(): TaxGatewaySettings {
  const values: Record<string, string | undefined> = {};
  const missing: string[] = [];
  for (const item of required) {
    values[item.key] = read(item.env);
    if (!values[item.key]) missing.push(item.label);
  }
  return {
    configured: missing.length === 0,
    endpoint: values.endpoint,
    fiscalId: values.fiscalId,
    nationalId: values.nationalId,
    missing,
  };
}

export type SendResult = { ok: true; referenceId: string } | { ok: false; error: string };

/**
 * ارسالِ یک صورت‌حساب به سامانه.
 * در صورت نبودِ تنظیمات یا خطای شبکه، نتیجه‌ی «ناموفق» با پیامِ فارسی برمی‌گردد
 * تا رکورد در صف بماند و بعداً دوباره تلاش شود.
 */
export async function sendInvoiceToTaxSystem(payload: unknown): Promise<SendResult> {
  const settings = taxSettings();
  if (!settings.configured) {
    return { ok: false, error: `تنظیماتِ اتصال کامل نیست: ${settings.missing.join('، ')}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(String(settings.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${read('TAX_API_KEY')}`,
        'X-Fiscal-Id': String(settings.fiscalId),
        'X-National-Id': String(settings.nationalId),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `سامانه پاسخِ ${response.status} داد${detail ? ` — ${detail}` : ''}` };
    }
    const body = (await response.json().catch(() => ({}))) as { referenceId?: string; taxId?: string; uid?: string };
    const referenceId = body.referenceId ?? body.taxId ?? body.uid ?? `LOCAL-${Date.now().toString(36).toUpperCase()}`;
    return { ok: true, referenceId: String(referenceId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('abort')) return { ok: false, error: 'زمانِ پاسخِ سامانه به پایان رسید' };
    return { ok: false, error: `برقراریِ ارتباط ناموفق بود: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- ساختارِ صورت‌حساب ------------------------------- */

export type TaxInvoiceLineInput = { itemTitle: string; quantity: number; unitPrice: number; unit?: string; sstid?: string };

/**
 * بدنه‌ی استانداردِ صورت‌حساب الکترونیکی را می‌سازد (مشابه ساختارِ اعلامی، با نام‌های فارسی).
 * مقادیر از فاکتورِ فروش گرفته می‌شوند و فروشنده از تنظیماتِ محیطی خوانده می‌شود؛
 * بنابراین چیزی در پایگاه داده ذخیره نمی‌شود.
 */
export function buildTaxInvoicePayload(input: {
  invoiceNumber: string;
  invoiceType?: string;
  issueDate?: string;
  buyerName: string;
  buyerNationalId?: string;
  buyerEconomicCode?: string;
  buyerAddress?: string;
  lines: TaxInvoiceLineInput[];
  discount?: number;
  vatRate?: number;
  organization?: { name?: string; code?: string; address?: string };
}): Record<string, unknown> {
  const settings = taxSettings();
  const vatRate = Number(input.vatRate ?? 10);
  const items = input.lines.map((line) => {
    const base = Math.round(Number(line.quantity) * Number(line.unitPrice));
    return {
      sstid: line.sstid ?? '',
      title: line.itemTitle,
      quantity: Number(line.quantity),
      unit: line.unit ?? 'عدد',
      unitPrice: Number(line.unitPrice),
      totalBeforeVat: base,
      vatRate,
      vatAmount: Math.round((base * vatRate) / 100),
    };
  });
  const totalBeforeVat = Math.max(0, items.reduce((sum, item) => sum + item.totalBeforeVat, 0) - Number(input.discount ?? 0));
  const totalVat = items.reduce((sum, item) => sum + item.vatAmount, 0);
  return {
    format: 'aria-tax-invoice',
    version: 1,
    createdAt: new Date().toISOString(),
    invoice: {
      invoiceNumber: input.invoiceNumber,
      invoiceType: input.invoiceType ?? 'فروش',
      issueDate: input.issueDate ?? new Date().toISOString().slice(0, 10),
      seller: {
        nationalId: settings.nationalId ?? '',
        fiscalId: settings.fiscalId ?? '',
        economicCode: read('TAX_ECONOMIC_CODE') ?? '',
        name: input.organization?.name ?? '',
        address: input.organization?.address ?? '',
      },
      buyer: {
        nationalId: input.buyerNationalId ?? '',
        economicCode: input.buyerEconomicCode ?? '',
        name: input.buyerName,
        address: input.buyerAddress ?? '',
      },
      items,
      discount: Number(input.discount ?? 0),
      vatRate,
      totalBeforeVat,
      totalVat,
      totalAmount: totalBeforeVat + totalVat,
    },
  };
}
