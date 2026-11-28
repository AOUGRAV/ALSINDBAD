import { z } from 'zod';
import { baseAmount, type Container, type Dataset, type Entry } from './domain';
import { containerCost } from './manifest';
import { riyalsPerPound } from './pounds';
import { invoiceLineTotal, invoiceVatPercent } from './purchases';

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
  source: z.object({ invoiceId: z.uuid(), itemIndex: z.number().int().min(0) }).optional(),
  invoiceIds: z.array(z.uuid()).optional(),
}).refine(row => row.name || row.english, 'Product name is required');
const expenseSchema = z.object({
  id: z.uuid(), label: text(500).min(1), stage: z.enum(expenseStages).or(z.literal('')),
  amount, currency: z.enum(pricingCurrencies), entryId: z.uuid().optional(),
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

const englishName = (item: { name: string; name_en?: string }) =>
  item.name_en?.trim() || (/^[\x00-\x7F]+$/.test(item.name) ? item.name : '');

function pricingExpenseFields(entry: Entry): Pick<PricingExpense, 'label' | 'amount' | 'currency'> {
  return {label: entry.description, amount: (entry.currency === 'GBP' ? entry.amount : baseAmount(entry)) / 100,
    currency: entry.currency === 'GBP' ? 'GBP' : 'SAR'};
}

export function copyExpenseForPricing(entry: Entry): PricingExpense {
  return {id: crypto.randomUUID(), entryId: entry.id, stage: '', ...pricingExpenseFields(entry)};
}

export function copyInvoiceForPricing(invoice: Entry, existing: PricingItem[]): PricingItem[] {
  if (invoice.kind !== 'purchase' || invoice.voided_at || !invoice.invoice_items) return [];
  const copied = new Set(existing.filter(row => row.source?.invoiceId === invoice.id).map(row => row.source!.itemIndex));
  const vat = invoice.invoice_vat_percent ?? invoiceVatPercent;
  let net = 0;
  let previousCost = 0;
  return invoice.invoice_items.flatMap((item, index) => {
    const line = invoiceLineTotal(item);
    if (line === null || item.quantity <= 0) throw new Error('بيانات بند الفاتورة غير صحيحة / Invalid invoice line');
    net += line;
    const cost = baseAmount(invoice, net + Math.floor((net * vat + 50) / 100));
    const lineCost = cost - previousCost;
    previousCost = cost;
    if (copied.has(index)) return [];
    return [{ id: crypto.randomUUID(), name: item.name, english: englishName(item), unit: item.unit,
      quantity: item.quantity, purchase: lineCost / 100 / pricingRate / item.quantity, pack: 1, sale: null,
      source: { invoiceId: invoice.id, itemIndex: index } }];
  });
}

type ContainerPricingRow = {name: string; english: string; unit: string; quantity: number; total: number; invoiceIds: Set<string>};

function containerPricingRows(data: Dataset, container: Container) {
  const { invoiceLines, lines, expenses } = containerCost(data, container);
  const entries = new Map(data.entries.map(entry => [entry.id, entry]));
  const products = new Map(data.products.map(product => [product.id, product]));
  const grouped = new Map<string, ContainerPricingRow>();
  function include(source: {name: string; name_en?: string; unit: string} | undefined, quantity: number, cost: number, invoiceId?: string) {
    if (!source || quantity <= 0) return;
    const english = englishName(source);
    const key = JSON.stringify([source.name, english.toLowerCase(), source.unit].map(s => s.trim().normalize('NFC')));
    const current = grouped.get(key) ?? {name: source.name, english, unit: source.unit, quantity: 0, total: 0, invoiceIds: new Set<string>()};
    current.quantity = Math.round((current.quantity + quantity) * 1000) / 1000;
    current.total += cost;
    if (invoiceId) current.invoiceIds.add(invoiceId);
    grouped.set(key, current);
  }
  for (const line of invoiceLines) include(entries.get(line.entry_id)?.invoice_items?.[line.item_index], line.quantity, line.cost_sar, line.entry_id);
  for (const line of lines) include(products.get(line.product_id), line.quantity, line.cost_sar);
  return { rows: Array.from(grouped.values()), expenses };
}

export function copyContainerForPricing(data: Dataset, container: Container): PricingDocument {
  const { rows, expenses } = containerPricingRows(data, container);
  return {
    allocation: 'quantity',
    items: rows.map(({total, invoiceIds, ...row}) => ({...row, id: crypto.randomUUID(), invoiceIds: [...invoiceIds],
      purchase: total / 100 / pricingRate / row.quantity, pack: 1, sale: null})),
    expenses: expenses.map(copyExpenseForPricing),
  };
}

const fingerprint = ({name, unit, quantity}: Pick<PricingItem, 'name' | 'unit' | 'quantity'>, cost: number) =>
  JSON.stringify([name.trim().normalize('NFC'), unit.trim(), Math.round(quantity * 1000), cost]);

// Earlier container copies stored amounts but did not record their source invoices.
// Match the original quantities and costs so an unrelated product name alone never blocks an invoice.
export function recoverPricingInvoiceSources(data: Dataset, sheet: Pick<PricingSheet, 'name' | 'document'>): PricingDocument {
  const {document} = sheet;
  const legacy = new Set(document.items.filter(row => !row.source && !row.invoiceIds)
    .map(row => fingerprint(row, Math.round(row.purchase * row.quantity * 100 * pricingRate))));
  if (!legacy.size) return document;
  const match = (container: Container) => {
    const matches = new Map<string, Set<string>>();
    for (const row of containerPricingRows(data, container).rows) {
      const key = fingerprint(row, row.total);
      if (!legacy.has(key)) continue;
      const ids = matches.get(key) ?? new Set<string>();
      for (const id of row.invoiceIds) ids.add(id);
      matches.set(key, ids);
    }
    return matches;
  };
  const named = data.containers.find(container => container.name.trim().toLowerCase() === sheet.name.trim().toLowerCase());
  const candidates = named ? [match(named)] : data.containers.map(match).filter(result => result.size === legacy.size);
  if (candidates.length !== 1 || !candidates[0].size) return document;
  return {...document, items: document.items.map(row => {
    if (row.source || row.invoiceIds) return row;
    const ids = candidates[0].get(fingerprint(row, Math.round(row.purchase * row.quantity * 100 * pricingRate)));
    return ids ? {...row, invoiceIds: [...ids]} : row;
  })};
}

export function pricingInvoiceIds(items: PricingItem[]) {
  const ids = new Set<string>();
  for (const row of items) {
    if (row.source) ids.add(row.source.invoiceId);
    for (const id of row.invoiceIds ?? []) ids.add(id);
  }
  return ids;
}

export function recoverPricingExpenseSources(data: Dataset, sheet: Pick<PricingSheet, 'name' | 'document'>): PricingExpense[] {
  const expenses = sheet.document.expenses;
  if (!expenses.some(row => !row.entryId)) return expenses;
  const container = data.containers.find(row => row.name.trim().toLowerCase() === sheet.name.trim().toLowerCase());
  if (!container) return expenses;
  // Older copies used the description and amount but omitted the expense ID.
  const key = (row: Pick<PricingExpense, 'label' | 'currency' | 'amount'>) => JSON.stringify([row.label.trim(), row.currency, row.amount]);
  const matches = new Map<string, string[]>();
  const claimed = new Set(expenses.map(row => row.entryId));
  for (const entry of data.entries) {
    if (entry.kind !== 'expense' || entry.voided_at || entry.container_id !== container.id) continue;
    const signature = key(pricingExpenseFields(entry));
    matches.set(signature, [...(matches.get(signature) ?? []), entry.id]);
  }
  return expenses.map(row => {
    if (row.entryId) return row;
    const ids = matches.get(key(row));
    if (ids?.length !== 1 || claimed.has(ids[0])) return row;
    claimed.add(ids[0]);
    return {...row, entryId: ids[0]};
  });
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
