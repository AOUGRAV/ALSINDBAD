import { z } from 'zod';
import { baseAmount, type Container, type Dataset } from './domain';
import { containerCost } from './manifest';
import { riyalsPerPound } from './pounds';

export const pricingRate = Number(riyalsPerPound);
export const pricingLimit = 500;
export const pricingCurrencies = ['GBP', 'SAR'] as const;
export const expenseStages = ['UK', 'Shipping', 'Jeddah'] as const;
const text = (max: number) => z.string().trim().max(max);
const amount = z.number().min(0).max(1_000_000_000_000);
const itemSchema = z.object({
  id: z.uuid(), name: text(180), english: text(180), unit: text(40).min(1),
  quantity: z.number().positive().max(100_000_000), purchase: amount,
  pack: z.number().int().min(1).max(100_000), sale: amount.nullable(),
}).refine(row => row.name || row.english, 'Product name is required');
const expenseSchema = z.object({
  id: z.uuid(), label: text(500).min(1), stage: z.enum(expenseStages).or(z.literal('')),
  amount, currency: z.enum(pricingCurrencies),
});
export const pricingDocumentSchema = z.object({
  allocation: z.enum(['quantity', 'value']), items: z.array(itemSchema).max(pricingLimit),
  expenses: z.array(expenseSchema).max(pricingLimit),
});
export const pricingSheetSchema = z.object({
  id: z.uuid(), name: text(160).min(1), version: z.uuid(), updated_at: z.string(),
  document: pricingDocumentSchema,
});
export type PricingDocument = z.infer<typeof pricingDocumentSchema>;
export type PricingSheet = z.infer<typeof pricingSheetSchema>;
export type PricingItem = z.infer<typeof itemSchema>;
export type PricingExpense = z.infer<typeof expenseSchema>;
export type PricingCurrency = typeof pricingCurrencies[number];

export const toPounds = (value: number, currency: PricingCurrency) => currency === 'SAR' ? value / pricingRate : value;
export const emptyPricing = (): PricingDocument => ({ allocation: 'quantity', items: [], expenses: [] });

export function copyContainerForPricing(data: Dataset, container: Container): PricingDocument {
  const { invoiceLines, lines, expenses } = containerCost(data, container);
  const entries = new Map(data.entries.map(entry => [entry.id, entry]));
  const products = new Map(data.products.map(product => [product.id, product]));
  const grouped = new Map<string, {name: string; english: string; unit: string; quantity: number; total: number}>();
  function include(source: {name: string; name_en?: string; unit: string} | undefined, quantity: number, cost: number) {
    if (!source || quantity <= 0) return;
    const english = source.name_en?.trim() || (/^[\x00-\x7F]+$/.test(source.name) ? source.name : '');
    const key = JSON.stringify([source.name, english.toLowerCase(), source.unit].map(s => s.trim().normalize('NFC')));
    const current = grouped.get(key) ?? {name: source.name, english, unit: source.unit, quantity: 0, total: 0};
    current.quantity = Math.round((current.quantity + quantity) * 1000) / 1000;
    current.total += cost;
    grouped.set(key, current);
  }
  for (const line of invoiceLines) include(entries.get(line.entry_id)?.invoice_items?.[line.item_index], line.quantity, line.cost_sar);
  for (const line of lines) include(products.get(line.product_id), line.quantity, line.cost_sar);
  return {
    allocation: 'quantity',
    items: Array.from(grouped.values(), ({total, ...row}) => ({...row, id: crypto.randomUUID(), purchase: total / 100 / pricingRate / row.quantity, pack: 1, sale: null})),
    expenses: expenses.map(entry => ({id: crypto.randomUUID(), label: entry.description, stage: '',
      amount: (entry.currency === 'GBP' ? entry.amount : baseAmount(entry)) / 100,
      currency: entry.currency === 'GBP' ? 'GBP' : 'SAR'})),
  };
}

export function unitPricing(quantity: number, purchase: number, expense: number, sale: number | null, pack = 1) {
  const landed = (purchase + expense / quantity) / pack;
  const profit = sale === null ? null : sale - landed;
  const revenue = sale === null ? null : sale * quantity * pack;
  const totalProfit = profit === null ? null : profit * quantity * pack;
  const margin = profit === null || !sale ? null : profit / sale;
  return { landed, profit, revenue, totalProfit, margin };
}

export function calculatePricing(document: PricingDocument) {
  const goods = document.items.reduce((sum, row) => sum + row.quantity * row.purchase, 0);
  const quantity = document.items.reduce((sum, row) => sum + row.quantity, 0);
  const expenses = document.expenses.reduce((sum, row) => sum + toPounds(row.amount, row.currency), 0);
  const denominator = document.allocation === 'value' ? goods : quantity;
  let revenue = 0;
  let profit = 0;
  let priced = 0;
  const rows = document.items.map(item => {
    const weight = document.allocation === 'value' ? item.purchase * item.quantity : item.quantity;
    const share = denominator ? expenses * weight / denominator : 0;
    const totals = unitPricing(item.quantity, item.purchase, share, item.sale, item.pack);
    if (totals.revenue !== null) {
      revenue += totals.revenue;
      profit += totals.totalProfit ?? 0;
      priced += 1;
    }
    return { ...totals, share };
  });
  return {goods, expenses, cost: goods + expenses, rows, priced, revenue, profit,
    margin: revenue ? profit / revenue : null, unallocated: denominator ? 0 : expenses};
}
