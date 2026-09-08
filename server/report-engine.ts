/**
 * موتور گزارش‌ساز دلخواه
 * ----------------------
 * هر گزارش با یک «تعریف» ساده ساخته می‌شود:
 *   منبع داده ← فیلترها ← گروه‌بندی و جمع‌بندی ← مرتب‌سازی ← محدودیت تعداد
 * منابع بر اساس داده‌های واقعی پایگاه (فایلی یا Postgres) هستند و خروجی
 * شامل ستون‌ها، ردیف‌ها و جمع کل است تا مستقیماً در جدول، اکسل یا چاپ استفاده شود.
 */

import * as store from './store.js';

export type ReportSourceId = 'journals' | 'inventory' | 'payroll' | 'checks' | 'serials' | 'boms' | 'documents' | 'audit';

export type FilterOperator = 'equals' | 'contains' | 'greater' | 'less' | 'between';
export type ReportFilter = { field: string; operator: FilterOperator; value: string | number; value2?: string | number };
export type AggregateKind = 'sum' | 'count' | 'avg' | 'min' | 'max';

export type ReportDefinition = {
  source: ReportSourceId;
  columns?: string[];
  filters?: ReportFilter[];
  groupBy?: string;
  aggregate?: { field: string; kind: AggregateKind }[];
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  limit?: number;
};

export type ReportResult = {
  source: ReportSourceId;
  sourceTitle: string;
  columns: string[];
  rows: Array<Record<string, string | number>>;
  totals: Record<string, number>;
  rowCount: number;
  generatedAt: string;
};

export const REPORT_SOURCES: Array<{ id: ReportSourceId; title: string; fields: Array<{ key: string; title: string; type: 'text' | 'number' | 'date' }> }> = [
  { id: 'journals', title: 'اسناد حسابداری', fields: [
    { key: 'number', title: 'شماره سند', type: 'number' }, { key: 'description', title: 'شرح', type: 'text' },
    { key: 'totalDebit', title: 'جمع بدهکار', type: 'number' }, { key: 'totalCredit', title: 'جمع بستانکار', type: 'number' },
    { key: 'status', title: 'وضعیت', type: 'text' }, { key: 'createdAt', title: 'تاریخ', type: 'date' },
  ] },
  { id: 'inventory', title: 'موجودی کالا', fields: [
    { key: 'sku', title: 'کد کالا', type: 'text' }, { key: 'title', title: 'کالا', type: 'text' },
    { key: 'quantity', title: 'موجودی', type: 'number' }, { key: 'unitCost', title: 'بهای واحد', type: 'number' },
    { key: 'value', title: 'ارزش', type: 'number' }, { key: 'movements', title: 'تعداد حرکت', type: 'number' },
  ] },
  { id: 'payroll', title: 'حقوق و دستمزد', fields: [
    { key: 'period', title: 'دوره', type: 'text' }, { key: 'personnelCode', title: 'کد پرسنلی', type: 'text' },
    { key: 'fullName', title: 'کارمند', type: 'text' }, { key: 'gross', title: 'ناخالص', type: 'number' },
    { key: 'net', title: 'خالص پرداختی', type: 'number' }, { key: 'insurance', title: 'سهم بیمه', type: 'number' },
    { key: 'tax', title: 'مالیات', type: 'number' }, { key: 'employerCost', title: 'هزینه کارفرما', type: 'number' },
  ] },
  { id: 'checks', title: 'چک‌ها', fields: [
    { key: 'number', title: 'شماره چک', type: 'text' }, { key: 'bank', title: 'بانک', type: 'text' },
    { key: 'amount', title: 'مبلغ', type: 'number' }, { key: 'direction', title: 'نوع', type: 'text' },
    { key: 'status', title: 'وضعیت', type: 'text' }, { key: 'dueDate', title: 'سررسید', type: 'date' },
  ] },
  { id: 'serials', title: 'شماره سریال‌ها', fields: [
    { key: 'serial', title: 'سریال', type: 'text' }, { key: 'itemTitle', title: 'کالا', type: 'text' },
    { key: 'warehouse', title: 'انبار', type: 'text' }, { key: 'status', title: 'وضعیت', type: 'text' }, { key: 'updatedAt', title: 'آخرین تغییر', type: 'date' },
  ] },
  { id: 'boms', title: 'صورت مواد (BOM)', fields: [
    { key: 'code', title: 'کد', type: 'text' }, { key: 'product', title: 'محصول', type: 'text' },
    { key: 'outputQuantity', title: 'خروجی', type: 'number' }, { key: 'componentsCount', title: 'تعداد مواد', type: 'number' },
    { key: 'laborMinutes', title: 'دستمزد (دقیقه)', type: 'number' }, { key: 'materialCost', title: 'بهای مواد', type: 'number' },
  ] },
  { id: 'documents', title: 'گردش کار', fields: [
    { key: 'title', title: 'عنوان', type: 'text' }, { key: 'moduleId', title: 'ماژول', type: 'text' },
    { key: 'status', title: 'وضعیت', type: 'text' }, { key: 'createdBy', title: 'ایجادکننده', type: 'text' }, { key: 'createdAt', title: 'تاریخ', type: 'date' },
  ] },
  { id: 'audit', title: 'ردپای حسابرسی', fields: [
    { key: 'actor', title: 'کاربر', type: 'text' }, { key: 'action', title: 'عملیات', type: 'text' },
    { key: 'entity', title: 'موجودیت', type: 'text' }, { key: 'at', title: 'زمان', type: 'date' },
  ] },
];

const numberOr = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** دریافت داده‌ی خام هر منبع به صورت ردیف‌های ساده */
async function loadSource(source: ReportSourceId): Promise<Array<Record<string, string | number>>> {
  if (source === 'journals') {
    const rows = await store.listJournalEntries().catch(() => []);
    return rows.map((entry) => ({ number: entry.number, description: entry.description, totalDebit: entry.totalDebit, totalCredit: entry.totalCredit, status: entry.status, createdAt: entry.createdAt?.slice(0, 10) ?? '' }));
  }
  if (source === 'inventory') {
    const rows = await store.listStockMovements().catch(() => []);
    const byItem = new Map<string, { sku: string; title: string; quantity: number; unitCost: number; movements: number }>();
    for (const movement of rows) {
      const key = String(movement.itemId ?? '');
      const current = byItem.get(key) ?? { sku: key, title: String(movement.itemTitle ?? ''), quantity: 0, unitCost: 0, movements: 0 };
      current.quantity += movement.type === 'خروج' ? -numberOr(movement.quantity) : numberOr(movement.quantity);
      current.movements += 1;
      if (movement.type === 'ورود' && numberOr(movement.quantity) > 0) {
        current.unitCost = current.movements <= 1 ? numberOr(movement.unitCost) : Math.round((current.unitCost + numberOr(movement.unitCost)) / 2);
      }
      byItem.set(key, current);
    }
    return [...byItem.values()].map((item) => ({
      sku: item.sku, title: item.title, quantity: item.quantity, unitCost: item.unitCost,
      movements: item.movements, value: Math.round(item.quantity * item.unitCost),
    }));
  }
  if (source === 'payroll') {
    const rows = await store.listPayrollRecords().catch(() => []);
    return rows.map((item) => ({
      period: item.period, personnelCode: item.personnelCode, fullName: item.fullName,
      gross: numberOr(item.result?.gross), net: numberOr(item.result?.netPay),
      insurance: numberOr(item.result?.insuranceEmployee), tax: numberOr(item.result?.incomeTax),
      overtime: numberOr(item.result?.overtime), employerCost: numberOr(item.result?.employerCost),
      createdAt: String(item.createdAt ?? '').slice(0, 10),
    }));
  }
  if (source === 'checks') {
    const rows = await store.listChecks().catch(() => []);
    return rows.map((item) => ({ number: String(item.number ?? ''), bank: String(item.bank ?? ''), amount: numberOr(item.amount), direction: String(item.direction ?? ''), status: String(item.status ?? ''), dueDate: String(item.dueDate ?? '') }));
  }
  if (source === 'serials') {
    const rows = await store.listSerials().catch(() => []);
    return rows.map((item) => ({ serial: item.serial, itemTitle: item.itemTitle, warehouse: item.warehouse, status: item.status, updatedAt: item.updatedAt.slice(0, 10) }));
  }
  if (source === 'boms') {
    const rows = await store.listBoms().catch(() => []);
    return rows.map((item) => ({
      code: item.code, product: item.product, outputQuantity: item.outputQuantity,
      componentsCount: item.components.length, laborMinutes: item.laborMinutes,
      materialCost: Math.round(item.components.reduce((sum, component) => sum + numberOr(component.quantity) * numberOr(component.unitCost), 0)),
    }));
  }
  if (source === 'documents') {
    const rows = await store.listDocuments().catch(() => []);
    return rows.map((item) => ({ title: String(item.title ?? ''), moduleId: String(item.moduleId ?? ''), status: String(item.status ?? ''), createdBy: String(item.createdBy ?? ''), createdAt: String(item.createdAt ?? '').slice(0, 10) }));
  }
  const rows = await store.listAudit(500).catch(() => []);
  return rows.map((item) => ({ actor: item.actor, action: item.action, entity: item.entity, at: String(item.at ?? '').slice(0, 19).replace('T', ' ') }));
}

/** نرمال‌سازی متن فارسی برای تطبیق کاربرپسند (ی/ک عربی، نیم‌فاصله، اعداد فارسی) */
export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u200c\u200d\u200f]/g, '') // نیم‌فاصله و کنترل‌های جهت
    .replace(/[\u0640]/g, '') // تطویل (کشیده)
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)) // اعداد فارسی
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0)) // اعداد فارسیِ بومی
    .replace(/[\u0622\u0623\u0625\u0627]/g, 'ا')
    .replace(/\u064a/g, 'ی').replace(/\u0649/g, 'ی')
    .replace(/\u0643/g, 'ک').replace(/\u0648\u200c?/g, 'و')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function matches(row: Record<string, string | number>, filter: ReportFilter): boolean {
  const actual = row[filter.field];
  if (actual === undefined) return true;
  const wanted = String(filter.value ?? '').trim();
  // فیلترِ بدون مقدار نادیده گرفته می‌شود تا خروجی ناخواسته خالی نشود
  if (!wanted && filter.operator !== 'between') return true;
  // مقایسه‌ی نهایی بدون فاصله انجام می‌شود تا «پیش نویس» و «پیش‌نویس» یکسان باشند
  const left = normalizeText(actual).replace(/\s+/g, '');
  const right = normalizeText(wanted).replace(/\s+/g, '');
  if (filter.operator === 'equals') return left === right;
  if (filter.operator === 'contains') return left.includes(right);
  if (filter.operator === 'greater') return numberOr(actual) > numberOr(filter.value);
  if (filter.operator === 'less') return numberOr(actual) < numberOr(filter.value);
  if (filter.operator === 'between') return numberOr(actual) >= numberOr(filter.value) && numberOr(actual) <= numberOr(filter.value2);
  return true;
}

function aggregateValue(values: number[], kind: AggregateKind): number {
  if (!values.length) return 0;
  if (kind === 'sum') return Math.round(values.reduce((sum, value) => sum + value, 0));
  if (kind === 'count') return values.length;
  if (kind === 'avg') return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  if (kind === 'min') return Math.min(...values);
  return Math.max(...values);
}

/** اجرای یک تعریف گزارش و تولید ستون‌ها، ردیف‌ها و جمع‌ها */
export async function runReport(definition: ReportDefinition): Promise<ReportResult> {
  const meta = REPORT_SOURCES.find((item) => item.id === definition.source);
  if (!meta) throw new Error('منبع گزارش معتبر نیست');
  let rows = await loadSource(definition.source);

  for (const filter of definition.filters ?? []) {
    if (!filter?.field) continue;
    rows = rows.filter((row) => matches(row, filter));
  }

  let columns = definition.columns?.length ? definition.columns : meta.fields.map((field) => field.key);
  const aggregates = definition.aggregate ?? [];

  // گروه‌بندی و جمع‌بندی
  if (definition.groupBy) {
    const groups = new Map<string, Array<Record<string, string | number>>>();
    for (const row of rows) {
      const key = String(row[definition.groupBy] ?? '—');
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }
    rows = [...groups.entries()].map(([key, bucket]) => {
      const row: Record<string, string | number> = { [definition.groupBy as string]: key, 'تعداد ردیف': bucket.length };
      for (const aggregate of aggregates) {
        const values = bucket.map((item) => numberOr(item[aggregate.field]));
        row[`${aggregate.kind === 'count' ? 'تعداد' : aggregate.kind} ${aggregate.field}`] = aggregateValue(values, aggregate.kind);
      }
      return row;
    });
    columns = [definition.groupBy, 'تعداد ردیف', ...aggregates.map((aggregate) => `${aggregate.kind === 'count' ? 'تعداد' : aggregate.kind} ${aggregate.field}`)];
  }

  // مرتب‌سازی
  if (definition.sortBy) {
    const direction = definition.sortDirection === 'asc' ? 1 : -1;
    rows = rows.slice().sort((left, right) => {
      const a = left[definition.sortBy as string];
      const b = right[definition.sortBy as string];
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction;
      return String(a ?? '').localeCompare(String(b ?? ''), 'fa') * direction;
    });
  }

  const limited = definition.limit && definition.limit > 0 ? rows.slice(0, Math.min(definition.limit, 2000)) : rows.slice(0, 2000);

  // جمع‌های عددی برای ستون‌های خروجی
  const totals: Record<string, number> = {};
  for (const column of columns) {
    const numeric = limited.map((row) => numberOr(row[column])).filter((value) => Number.isFinite(value));
    if (numeric.length && limited.some((row) => typeof row[column] === 'number')) totals[column] = Math.round(numeric.reduce((sum, value) => sum + value, 0));
  }

  const projected = limited.map((row) => {
    const result: Record<string, string | number> = {};
    for (const column of columns) result[column] = row[column] ?? '';
    return result;
  });

  return {
    source: definition.source,
    sourceTitle: meta.title,
    columns,
    rows: projected,
    totals,
    rowCount: projected.length,
    generatedAt: new Date().toISOString(),
  };
}
