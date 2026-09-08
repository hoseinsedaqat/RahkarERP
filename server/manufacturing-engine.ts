/**
 * موتور بهای تمام‌شده تولید
 * -------------------------
 * ورودی: صورت مواد (BOM) + تعداد تولید + نرخ‌های دستمزد و سربار
 * خروجی: بهای مواد مستقیم، دستمزد مستقیم، سربار، بهای هر واحد، درصد انحراف از استاندارد
 *        و سند حسابداریِ انتقال به کالای در جریان ساخت (۱۴۰۰).
 */

import type { BomRecord } from './store.js';

export type ProductionCostInput = {
  bom: BomRecord;
  /** تعداد تولیدیِ برنامه‌ریزی‌شده */
  quantity: number;
  /** نرخ سربار به‌ازای هر دقیقه کار (در صورت استفاده از مبنای زمان) */
  overheadRatePerMinute?: number;
  /** درصد ضایعات سراسری که روی مواد اعمال می‌شود */
  scrapPercent?: number;
  /** بهای استاندارد هر واحد (برای محاسبه‌ی انحراف) */
  standardUnitCost?: number;
};

export type MaterialLine = {
  title: string;
  unit: string;
  unitCost: number;
  /** مقدار مورد نیاز برای کل تولید (با احتساب ضایعات) */
  requiredQuantity: number;
  /** مقدار هر واحد محصول */
  perUnitQuantity: number;
  cost: number;
  scrapPercent: number;
};

export type ProductionCostResult = {
  bomCode: string;
  product: string;
  quantity: number;
  materialCost: number;
  laborCost: number;
  overheadCost: number;
  totalCost: number;
  unitCost: number;
  standardUnitCost: number;
  variance: number;
  variancePercent: number;
  materials: MaterialLine[];
  laborMinutes: number;
  journal: { description: string; lines: Array<{ accountCode: string; accountTitle: string; debit: number; credit: number; description?: string }> };
};

const round = (value: number): number => Math.round(value);

/** محاسبه‌ی بهای تمام‌شده یک دوره تولید */
export function productionCost(input: ProductionCostInput): ProductionCostResult {
  const bom = input.bom;
  const quantity = Math.max(0, Math.floor(Number(input.quantity) || 0));
  const globalScrap = Math.max(0, Math.min(100, Number(input.scrapPercent) || 0));
  const outputPerRun = bom.outputQuantity > 0 ? bom.outputQuantity : 1;

  const materials: MaterialLine[] = bom.components.map((component) => {
    const scrap = Math.max(Number(component.scrapPercent) || 0, globalScrap);
    const grossPerUnit = Math.max(0, Number(component.quantity) || 0) * (1 + scrap / 100);
    const runs = quantity / outputPerRun;
    const requiredQuantity = grossPerUnit * runs;
    return {
      title: component.title,
      unit: component.unit,
      unitCost: round(Math.max(0, Number(component.unitCost) || 0)),
      perUnitQuantity: Number(grossPerUnit.toFixed(4)),
      requiredQuantity: Number(requiredQuantity.toFixed(4)),
      cost: round(requiredQuantity * Math.max(0, Number(component.unitCost) || 0)),
      scrapPercent: scrap,
    };
  });

  const materialCost = materials.reduce((sum, line) => sum + line.cost, 0);

  // دستمزد مستقیم: دقیقه‌ی کار برای هر دوره × تعداد دوره × نرخ دقیقه‌ای
  const runs = quantity / outputPerRun;
  const laborMinutes = round(Math.max(0, Number(bom.laborMinutes) || 0) * runs);
  const laborCost = round(laborMinutes * Math.max(0, Number(bom.laborRatePerMinute) || 0));

  // سربار: مبلغ ثابت هر واحد + نرخ دقیقه‌ای (در صورت تعیین)
  const overheadPerUnit = Math.max(0, Number(bom.overheadPerUnit) || 0);
  const overheadRate = Math.max(0, Number(input.overheadRatePerMinute) || 0);
  const overheadCost = round(quantity * overheadPerUnit + laborMinutes * overheadRate);

  const totalCost = materialCost + laborCost + overheadCost;
  const unitCost = quantity > 0 ? totalCost / quantity : 0;
  const standardUnitCost = Math.max(0, Number(input.standardUnitCost) || 0);
  const variance = round((unitCost - standardUnitCost) * quantity);
  const variancePercent = standardUnitCost > 0 ? Number((((unitCost - standardUnitCost) / standardUnitCost) * 100).toFixed(2)) : 0;

  return {
    bomCode: bom.code,
    product: bom.product,
    quantity,
    materialCost,
    laborCost,
    overheadCost,
    totalCost: round(totalCost),
    unitCost: round(unitCost),
    standardUnitCost: round(standardUnitCost),
    variance,
    variancePercent,
    materials,
    laborMinutes,
    journal: totalCost > 0
      ? {
          description: `بهای تمام‌شده تولید ${bom.product} — ${quantity} واحد`,
          lines: [
            { accountCode: '1400', accountTitle: 'کالای در جریان ساخت', debit: round(totalCost), credit: 0, description: 'جمع بهای تولید' },
            { accountCode: '1300', accountTitle: 'موجودی مواد و کالا', debit: 0, credit: materialCost, description: 'مواد مصرفی' },
            { accountCode: '6100', accountTitle: 'حقوق و دستمزد', debit: 0, credit: laborCost, description: 'دستمزد مستقیم تولید' },
            { accountCode: '6000', accountTitle: 'سربار تولید', debit: 0, credit: overheadCost, description: 'سربار تخصیص‌یافته' },
          ].filter((line) => line.debit > 0 || line.credit > 0),
        }
      : { description: '', lines: [] },
  };
}

/** برآورد سریع بهای واحد برای نمایش در فهرست BOMها */
export function estimateUnitCost(bom: BomRecord): number {
  const result = productionCost({ bom, quantity: bom.outputQuantity > 0 ? bom.outputQuantity : 1 });
  return result.unitCost;
}
