import { z } from 'zod';
import { invoiceItemSchema, invoiceTotals, maxInvoiceItems, type InvoiceItem } from './purchases';

export const currencies = ['SAR', 'USD', 'GBP', 'EUR'] as const;
export const kinds = ['funding', 'borrow', 'lend', 'purchase', 'expense', 'asset', 'collect', 'repay'] as const;
export type Currency = typeof currencies[number];
export type Kind = typeof kinds[number];
export type Lang = 'ar' | 'en';
export const kindLabels: Record<Kind, [string, string]> = {
  funding: ['تمويل من المالك', 'Owner funding'], borrow: ['قرض مستلم', 'Borrowed funds'],
  lend: ['سلفة ممنوحة', 'Money lent'], purchase: ['شراء', 'Purchase'],
  expense: ['مصروف', 'Expense'], asset: ['شراء أصل', 'Asset purchase'],
  collect: ['تحصيل دين', 'Debt collection'], repay: ['سداد التزام', 'Debt repayment'],
};
export const entrySchema = z.object({
  id: z.uuid(), date: z.iso.date(), kind: z.enum(kinds), party: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500), category: z.string().trim().min(1).max(80),
  scope: z.enum(['business', 'personal']), currency: z.enum(currencies),
  amount: z.number().int().positive().max(100_000_000_000),
  paid: z.number().int().nonnegative(), rate: z.number().positive().max(10000)
    .refine(rate => Math.round(rate * 1_000_000) / 1_000_000 === rate, 'أدخل حتى ست خانات عشرية / Rate supports up to six decimal places'),
  method: z.enum(['cash', 'bank', 'card']), product_id: z.uuid().nullable(),
  quantity: z.number().int().nonnegative().max(100000000), settles_id: z.uuid().nullable(),
  receipt_path: z.string().nullable(), container_id: z.uuid().nullable(), created_at: z.string(),
  invoice_number: z.string().trim().min(1).max(80).nullish(),
  invoice_items: z.array(invoiceItemSchema).min(1).max(maxInvoiceItems).nullish(),
  opening: z.boolean().default(false), revision: z.number().int().positive().default(1), voided_at: z.string().nullable().default(null),
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.paid > v.amount) issue('المدفوع أكبر من الإجمالي / Paid exceeds total');
  if (v.kind !== 'purchase' && v.paid !== v.amount) issue('يلزم دفع كامل المبلغ / Full payment required');
  if (v.currency === 'SAR' && v.rate !== 1) issue('سعر الريال يجب أن يكون 1 / SAR rate must be 1');
  if (v.kind === 'purchase') {
    if (v.invoice_number || v.invoice_items) {
      if (!v.invoice_number || !v.invoice_items || v.product_id || v.quantity) issue('رقم الفاتورة وبنودها مطلوبة / Invoice number and items are required');
      else if (invoiceTotals(v.invoice_items)?.total !== v.amount) issue('الإجمالي لا يطابق بنود الفاتورة / Total does not match invoice items');
    } else if (!v.product_id || v.quantity < 1) issue('اختر الصنف والكمية / Product and quantity required');
  } else if (v.product_id || v.quantity || v.invoice_number || v.invoice_items) issue('بنود الفاتورة خاصة بالمشتريات / Invoice items are only for purchases');
  if (['collect', 'repay'].includes(v.kind) !== Boolean(v.settles_id)) issue('اربط السداد بالدين / Link settlement to a debt');
  if (v.container_id && (v.kind !== 'expense' || v.scope !== 'business')) issue('اربط الحاوية بمصروف تشغيلي / Only business expenses can link to containers');
  if (v.opening && !['borrow', 'lend'].includes(v.kind)) issue('الرصيد الافتتاحي مخصص للديون القائمة / Opening balances apply to existing debts');
});
export type Entry = z.infer<typeof entrySchema>;
export type Product = { id: string; name: string; category: string; unit: string; expiry: string | null; created_at: string };
export type Container = { id: string; name: string; destination: string; booking: string; status: 'preparing' | 'shipped' | 'arrived'; created_at: string };
export type LoadDraft = { id: string; container_id: string; product_id: string; quantity: number; created_at: string };
export type Load = LoadDraft & { cost_sar: number };
export type EntryHistory = { entry_id: string; revision: number; action: 'correct' | 'void'; reason: string; previous: Entry; recorded_at: string };
export type Dataset = { entries: Entry[]; products: Product[]; containers: Container[]; loads: Load[]; history: EntryHistory[] };
export const emptyData = (): Dataset => ({ entries: [], products: [], containers: [], loads: [], history: [] });
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
export const minor = (value: string | number) => Math.round(Number(value) * 100);
export function toSar(amount: number, rate: number) {
  const million = 1_000_000n;
  return Number((BigInt(amount) * BigInt(Math.round(rate * Number(million))) + million / 2n) / million);
}
export function rateForSarTotal(amount: number, total: number) {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total) || amount <= 0 || total <= 0) return null;
  const principal = BigInt(amount);
  const rate = Number((BigInt(total) * 1_000_000n + principal / 2n) / principal) / 1_000_000;
  return rate > 0 && rate <= 10_000 ? rate : null;
}
export const baseAmount = (entry: Entry, amount = entry.amount) => toSar(amount, entry.rate);
export const money = (amount: number, currency: Currency = 'SAR', lang: Lang = 'ar') =>
  new Intl.NumberFormat(lang === 'ar' ? 'ar-SA' : 'en-GB', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount / 100);
export const cashSign = (kind: Kind) => ['funding', 'borrow', 'collect'].includes(kind) ? 1 : -1;
export const activeEntries = (entries: Entry[]) => entries.filter(entry => !entry.voided_at);
export const cashAmount = (entry: Entry, inSar = false) => entry.opening || entry.voided_at ? 0 :
  cashSign(entry.kind) * (inSar ? baseAmount(entry, entry.paid) : entry.paid);
export const debtPrincipal = (e: Entry) => e.kind === 'purchase' ? e.amount - e.paid : ['borrow', 'lend'].includes(e.kind) ? e.amount : 0;
export const debtBalance = (entry: Entry, entries: Entry[]) => entry.voided_at ? 0 : debtPrincipal(entry) -
  entries.filter(x => !x.voided_at && x.settles_id === entry.id).reduce((sum, x) => sum + x.amount, 0);
export type DebtDirection = 'receivable' | 'payable';
export const debtSide = (e: Entry): DebtDirection => e.kind === 'lend' ? 'receivable' : 'payable';
const settlementKind = (debt: Entry) => debtSide(debt) === 'receivable' ? 'collect' : 'repay';
export function validateEntry(input: unknown, data: Dataset, original?: Entry): Entry {
  const e = entrySchema.parse(input);
  if (!original && data.entries.some(x => x.id === e.id)) throw new Error('العملية مسجلة مسبقًا / Duplicate entry');
  if (e.product_id && !data.products.some(x => x.id === e.product_id)) throw new Error('الصنف غير موجود / Product not found');
  if (e.container_id && !data.containers.some(x => x.id === e.container_id)) throw new Error('الحاوية غير موجودة / Container not found');
  if (e.settles_id) {
    const debt = data.entries.find(x => x.id === e.settles_id && !x.voided_at);
    if (!debt || debtPrincipal(debt) === 0) throw new Error('الدين غير موجود / Debt not found');
    if (debt.currency !== e.currency) throw new Error('السداد بنفس عملة الدين / Settle in the debt currency');
    if (settlementKind(debt) !== e.kind) throw new Error('نوع السداد غير صحيح / Invalid settlement kind');
    if (e.amount > debtBalance(debt, data.entries.filter(x => x.id !== original?.id))) throw new Error('المبلغ يتجاوز المتبقي / Settlement exceeds balance');
    if (e.date < debt.date) throw new Error('السداد يسبق تاريخ الدين / Settlement predates debt');
    if (e.party !== debt.party || e.scope !== debt.scope) throw new Error('جهة السداد وتصنيفه يجب أن يطابقا الدين / Settlement must match debt');
  }
  return e;
}

type DebtDraft = Pick<Entry, 'id' | 'created_at' | 'date' | 'amount' | 'rate' | 'method' | 'description'> &
  ({ debt: Entry } | Pick<Entry, 'party' | 'category' | 'scope' | 'currency' | 'opening'> & { direction: DebtDirection });

export function prepareDebtEntry(draft: DebtDraft, data: Dataset, original?: Entry) {
  const common = { paid: draft.amount, quantity: 0, product_id: null, container_id: null, receipt_path: original?.receipt_path ?? null };
  if ('debt' in draft) {
    const { debt, ...fields } = draft;
    return validateEntry({ ...common, ...fields, kind: settlementKind(debt), settles_id: debt.id,
      party: debt.party, scope: debt.scope, category: debt.category, currency: debt.currency }, data, original);
  }
  const { direction, ...fields } = draft;
  return validateEntry({ ...common, ...fields, kind: direction === 'receivable' ? 'lend' : 'borrow', settles_id: null }, data, original);
}

type PurchaseInvoiceDraft = Pick<Entry, 'id' | 'created_at' | 'date' | 'party' | 'description' | 'category' | 'currency' | 'rate' | 'method'> &
  { invoice_number: string; invoice_items: InvoiceItem[]; paid?: number };

export function preparePurchaseInvoice(draft: PurchaseInvoiceDraft, data: Dataset, original?: Entry) {
  const totals = invoiceTotals(draft.invoice_items);
  if (!totals || totals.total <= 0) throw new Error('تحقق من الكميات والأسعار. يجب أن يكون إجمالي الفاتورة أكبر من صفر. / Check the invoice quantities and prices.');
  return validateEntry({
    ...draft, kind: 'purchase', amount: totals.total, paid: draft.paid ?? totals.total, scope: original?.scope ?? 'business',
    product_id: null, quantity: 0, settles_id: null, container_id: null, receipt_path: original?.receipt_path ?? null,
  }, data, original);
}
export function inventory(data: Dataset, productId: string) {
  const purchases = data.entries.filter(e => !e.voided_at && e.product_id === productId);
  const purchased = purchases.reduce((a, e) => a + e.quantity, 0);
  const loaded = data.loads.filter(e => e.product_id === productId).reduce((a, e) => a + e.quantity, 0);
  const value = purchases.reduce((a, e) => a + baseAmount(e), 0);
  return { purchased, loaded, remaining: purchased - loaded, value, unitCost: purchased ? value / purchased : 0 };
}
export function validateLoad(load: LoadDraft, data: Dataset) {
  if (!Number.isSafeInteger(load.quantity) || load.quantity <= 0) throw new Error('الكمية غير صحيحة / Invalid quantity');
  if (data.loads.some(x => x.id === load.id)) throw new Error('التحميل مسجل مسبقًا / Duplicate load');
  const container = data.containers.find(x => x.id === load.container_id);
  if (!container || container.status !== 'preparing') throw new Error('الحاوية غير متاحة للتحميل / Container is not open');
  if (!data.products.some(x => x.id === load.product_id) || inventory(data, load.product_id).remaining < load.quantity) throw new Error('الكمية تتجاوز المخزون / Insufficient stock');
  return load;
}
export function summary(entries: Entry[]) {
  const active = activeEntries(entries);
  const cash = active.reduce((a, e) => a + cashAmount(e, true), 0);
  const purchases = active.filter(e => e.kind === 'purchase').reduce((a, e) => a + baseAmount(e), 0);
  const expenses = active.filter(e => e.kind === 'expense').reduce((a, e) => a + baseAmount(e), 0);
  const debts = active.filter(e => debtPrincipal(e) > 0);
  const receivable = debts.filter(e => debtSide(e) === 'receivable').reduce((a, e) => a + baseAmount(e, debtBalance(e, active)), 0);
  const payable = debts.filter(e => debtSide(e) === 'payable').reduce((a, e) => a + baseAmount(e, debtBalance(e, active)), 0);
  return { cash, purchases, expenses, receivable, payable };
}
