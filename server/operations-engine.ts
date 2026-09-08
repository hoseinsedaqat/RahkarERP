/**
 * موتور عملیات تکمیلی فاز ۲
 *
 * ۱) بهای تمام‌شده‌ی موجودی: میانگین موزون (WAC) و FIFO
 * ۲) تطبیق بانکی: مقایسه‌ی صورت‌حساب بانک با سطرهای حساب بانک در اسناد
 *
 * محاسبات فقط از «حرکت‌های انبار» و «اسناد قطعی» انجام می‌شود تا گزارش‌ها
 * با دفاتر حسابداری هم‌خوان باشند.
 */

export type StockMovement = {
  id: string;
  itemId: string;
  itemTitle: string;
  date: string;
  type: 'ورود' | 'خروج';
  quantity: number;
  unitCost?: number;      // فقط برای ورود
  costAmount: number;     // بهای محاسبه‌شده‌ی این حرکت
  reference?: string;
  method: 'wac' | 'fifo';
  createdAt: string;
  organizationId?: string;
};

export type CostingRow = {
  itemId: string;
  itemTitle: string;
  quantity: number;
  unitCost: number;
  value: number;
  layers: Array<{ quantity: number; unitCost: number }>;
};

const currency = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;
/** بهای واحد با دقت بیشتر تا گردکردن روی مقادیر کل اثر نگذارد */
const rate = (value: number): number => Math.round((Number(value) || 0) * 10000) / 10000;

/* ===================== ۱) بهای تمام‌شده ===================== */

/** مانده و بهای هر کالا با روش میانگین موزون */
export function wacCosting(movements: StockMovement[]): CostingRow[] {
  const rows = new Map<string, CostingRow>();
  for (const move of [...movements].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))) {
    const row = rows.get(move.itemId) ?? { itemId: move.itemId, itemTitle: move.itemTitle, quantity: 0, unitCost: 0, value: 0, layers: [] };
    if (move.type === 'ورود') {
      const quantity = row.quantity + move.quantity;
      const value = row.value + (move.unitCost ?? 0) * move.quantity;
      row.quantity = currency(quantity);
      row.value = currency(value);
      row.unitCost = row.quantity > 0 ? rate(row.value / row.quantity) : 0;
      row.layers.push({ quantity: move.quantity, unitCost: currency(move.unitCost ?? 0) });
    } else {
      const quantity = Math.max(0, row.quantity - move.quantity);
      const issued = Math.min(move.quantity, row.quantity);
      row.value = currency(row.value - row.unitCost * issued);
      row.quantity = currency(quantity);
      if (row.quantity <= 0) { row.value = 0; row.unitCost = 0; row.layers = []; }
      // در FIFO مصرف از قدیمی‌ترین لایه انجام می‌شود
      let remaining = issued;
      while (remaining > 0 && row.layers.length) {
        const layer = row.layers[0];
        if (layer.quantity <= remaining) { remaining -= layer.quantity; row.layers.shift(); }
        else { layer.quantity = currency(layer.quantity - remaining); remaining = 0; }
      }
    }
    rows.set(move.itemId, row);
  }
  return [...rows.values()].sort((a, b) => a.itemTitle.localeCompare(b.itemTitle, 'fa'));
}

/** بهای خروج بر اساس لایه‌های FIFO */
export function fifoIssueCost(movements: StockMovement[], itemId: string, quantity: number, date: string): { unitCost: number; amount: number; sufficient: boolean } {
  const layers: Array<{ quantity: number; unitCost: number }> = [];
  for (const move of [...movements].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))) {
    if (move.itemId !== itemId) continue;
    if (move.type === 'ورود') layers.push({ quantity: move.quantity, unitCost: currency(move.unitCost ?? 0) });
    else {
      let remaining = move.quantity;
      while (remaining > 0 && layers.length) {
        if (layers[0].quantity <= remaining) { remaining -= layers[0].quantity; layers.shift(); }
        else { layers[0].quantity = currency(layers[0].quantity - remaining); remaining = 0; }
      }
    }
  }
  const available = layers.reduce((sum, layer) => sum + layer.quantity, 0);
  if (available < quantity - 0.0001) return { unitCost: 0, amount: 0, sufficient: false };
  let remaining = quantity;
  let amount = 0;
  for (const layer of layers) {
    if (remaining <= 0) break;
    const take = Math.min(layer.quantity, remaining);
    amount += take * layer.unitCost;
    remaining -= take;
  }
  return { unitCost: quantity > 0 ? rate(amount / quantity) : 0, amount: currency(amount), sufficient: true };
}

/* ===================== ۲) تطبیق بانکی ===================== */

export type BankStatementRow = {
  id: string;
  date: string;
  description: string;
  reference?: string;
  amount: number;
  direction: 'دریافت' | 'پرداخت';
  matchedEntryId?: string;
  createdAt: string;
};

export type BankLedgerLine = {
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  amount: number;
  direction: 'دریافت' | 'پرداخت';
};

export type MatchSuggestion = { statementId: string; entryId: string; amount: number; dateDistance: number; confidence: number };

/** تطبیق خودکار: مبلغ برابر + کمترین فاصله‌ی تاریخ */
export function reconcileBank(statements: BankStatementRow[], lines: BankLedgerLine[]): {
  statements: BankStatementRow[];
  ledger: BankLedgerLine[];
  matched: Array<{ statement: BankStatementRow; line: BankLedgerLine }>;
  unmatchedStatements: BankStatementRow[];
  unmatchedLines: BankLedgerLine[];
  suggestions: MatchSuggestion[];
} {
  const usedLines = new Set(statements.filter((row) => row.matchedEntryId).map((row) => row.matchedEntryId as string));
  const matched: Array<{ statement: BankStatementRow; line: BankLedgerLine }> = [];
  for (const statement of statements) {
    if (!statement.matchedEntryId) continue;
    const line = lines.find((item) => item.entryId === statement.matchedEntryId);
    if (line) matched.push({ statement, line });
  }
  const unmatchedStatements = statements.filter((row) => !row.matchedEntryId);
  const unmatchedLines = lines.filter((item) => !usedLines.has(item.entryId));
  const suggestions: MatchSuggestion[] = [];
  for (const statement of unmatchedStatements) {
    for (const line of unmatchedLines) {
      if (line.direction !== statement.direction) continue;
      const difference = Math.abs(line.amount - statement.amount);
      if (difference > Math.max(1, statement.amount * 0.001)) continue; // مبلغ باید برابر باشد
      const dateDistance = Math.abs(new Date(line.date).getTime() - new Date(statement.date).getTime()) / 86_400_000;
      suggestions.push({
        statementId: statement.id,
        entryId: line.entryId,
        amount: statement.amount,
        dateDistance,
        confidence: Math.max(0, 100 - dateDistance * 5),
      });
    }
  }
  suggestions.sort((a, b) => b.confidence - a.confidence);
  return { statements, ledger: lines, matched, unmatchedStatements, unmatchedLines, suggestions };
}
