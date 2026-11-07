import { z } from 'zod';

export const currencies = ['SAR', 'USD', 'GBP', 'EUR'] as const;
export const kinds = ['funding', 'borrow', 'lend', 'purchase', 'expense', 'asset', 'collect', 'repay'] as const;
export type Currency = typeof currencies[number];
export type Kind = typeof kinds[number];
export type Lang = 'ar' | 'en';
export const kindLabels: Record<Kind, [string, string]> = {
  funding: ['تمويل من المالك', 'Owner funding'], borrow: ['قرض مستلم', 'Borrowed funds'],
  lend: ['سلفة ممنوحة', 'Money lent'], purchase: ['شراء بضاعة', 'Stock purchase'],
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
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.paid > v.amount) issue('المدفوع أكبر من الإجمالي / Paid exceeds total');
  if (v.kind !== 'purchase' && v.paid !== v.amount) issue('يلزم دفع كامل المبلغ / Full payment required');
  if (v.currency === 'SAR' && v.rate !== 1) issue('سعر الريال يجب أن يكون 1 / SAR rate must be 1');
  if (v.kind === 'purchase' && (!v.product_id || v.quantity < 1)) issue('اختر الصنف والكمية / Product and quantity required');
  if (v.kind !== 'purchase' && (v.product_id || v.quantity)) issue('الصنف خاص بالمشتريات / Product is only for purchases');
  if (['collect', 'repay'].includes(v.kind) !== Boolean(v.settles_id)) issue('اربط السداد بالدين / Link settlement to a debt');
  if (v.container_id && (v.kind !== 'expense' || v.scope !== 'business')) issue('اربط الحاوية بمصروف تشغيلي / Only business expenses can link to containers');
});
export type Entry = z.infer<typeof entrySchema>;
export type Product = { id: string; name: string; category: string; unit: string; expiry: string | null; created_at: string };
export type Container = { id: string; name: string; destination: string; booking: string; status: 'preparing' | 'shipped' | 'arrived'; created_at: string };
export type Load = { id: string; container_id: string; product_id: string; quantity: number; created_at: string };
export type Dataset = { entries: Entry[]; products: Product[]; containers: Container[]; loads: Load[] };
export const emptyData = (): Dataset => ({ entries: [], products: [], containers: [], loads: [] });
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
export const minor = (value: string | number) => Math.round(Number(value) * 100);
export function toSar(amount: number, rate: number) {
  const million = 1_000_000n;
  return Number((BigInt(amount) * BigInt(Math.round(rate * Number(million))) + million / 2n) / million);
}
export const baseAmount = (entry: Entry, amount = entry.amount) => toSar(amount, entry.rate);
export const money = (amount: number, currency: Currency = 'SAR', lang: Lang = 'ar') =>
  new Intl.NumberFormat(lang === 'ar' ? 'ar-SA' : 'en-GB', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount / 100);
export const cashSign = (kind: Kind) => ['funding', 'borrow', 'collect'].includes(kind) ? 1 : -1;
export const debtPrincipal = (e: Entry) => e.kind === 'purchase' ? e.amount - e.paid : ['borrow', 'lend'].includes(e.kind) ? e.amount : 0;
export const debtBalance = (entry: Entry, entries: Entry[]) => debtPrincipal(entry) - entries.filter(x => x.settles_id === entry.id).reduce((sum, x) => sum + x.amount, 0);
export const debtSide = (e: Entry) => e.kind === 'lend' ? 'receivable' : 'payable';
export function validateEntry(input: unknown, data: Dataset): Entry {
  const e = entrySchema.parse(input);
  if (data.entries.some(x => x.id === e.id)) throw new Error('العملية مسجلة مسبقًا / Duplicate entry');
  if (e.product_id && !data.products.some(x => x.id === e.product_id)) throw new Error('الصنف غير موجود / Product not found');
  if (e.container_id && !data.containers.some(x => x.id === e.container_id)) throw new Error('الحاوية غير موجودة / Container not found');
  if (e.settles_id) {
    const debt = data.entries.find(x => x.id === e.settles_id);
    if (!debt || debtPrincipal(debt) === 0) throw new Error('الدين غير موجود / Debt not found');
    if (debt.currency !== e.currency) throw new Error('السداد بنفس عملة الدين / Settle in the debt currency');
    if ((debt.kind === 'lend' ? 'collect' : 'repay') !== e.kind) throw new Error('نوع السداد غير صحيح / Invalid settlement kind');
    if (e.amount > debtBalance(debt, data.entries)) throw new Error('المبلغ يتجاوز المتبقي / Settlement exceeds balance');
    if (e.date < debt.date) throw new Error('السداد يسبق تاريخ الدين / Settlement predates debt');
    if (e.party !== debt.party || e.scope !== debt.scope) throw new Error('جهة السداد وتصنيفه يجب أن يطابقا الدين / Settlement must match debt');
  }
  return e;
}
export function inventory(data: Dataset, productId: string) {
  const purchased = data.entries.filter(e => e.product_id === productId).reduce((a, e) => a + e.quantity, 0);
  const loaded = data.loads.filter(e => e.product_id === productId).reduce((a, e) => a + e.quantity, 0);
  const value = data.entries.filter(e => e.product_id === productId).reduce((a, e) => a + baseAmount(e), 0);
  return { purchased, loaded, remaining: purchased - loaded, value, unitCost: purchased ? value / purchased : 0 };
}
export function validateLoad(load: Load, data: Dataset) {
  if (!Number.isSafeInteger(load.quantity) || load.quantity <= 0) throw new Error('الكمية غير صحيحة / Invalid quantity');
  if (data.loads.some(x => x.id === load.id)) throw new Error('التحميل مسجل مسبقًا / Duplicate load');
  const container = data.containers.find(x => x.id === load.container_id);
  if (!container || container.status !== 'preparing') throw new Error('الحاوية غير متاحة للتحميل / Container is not open');
  if (!data.products.some(x => x.id === load.product_id) || inventory(data, load.product_id).remaining < load.quantity) throw new Error('الكمية تتجاوز المخزون / Insufficient stock');
  return load;
}
export function summary(entries: Entry[]) {
  const cash = entries.reduce((a, e) => a + cashSign(e.kind) * baseAmount(e, e.paid), 0);
  const purchases = entries.filter(e => e.kind === 'purchase').reduce((a, e) => a + baseAmount(e), 0);
  const expenses = entries.filter(e => e.kind === 'expense').reduce((a, e) => a + baseAmount(e), 0);
  const debts = entries.filter(e => debtPrincipal(e) > 0);
  const receivable = debts.filter(e => debtSide(e) === 'receivable').reduce((a, e) => a + baseAmount(e, debtBalance(e, entries)), 0);
  const payable = debts.filter(e => debtSide(e) === 'payable').reduce((a, e) => a + baseAmount(e, debtBalance(e, entries)), 0);
  return { cash, purchases, expenses, receivable, payable };
}
