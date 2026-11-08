import { z } from 'zod';

export const invoiceVatPercent = 15;
export const maxInvoiceItems = 50;
const maxEntryMinor = 100_000_000_000;

export const invoiceItemSchema = z.object({
  name: z.string().trim().min(1).max(140),
  quantity: z.number().min(0.001).max(100_000_000)
    .refine(value => Math.round(value * 1000) / 1000 === value, 'الكمية تقبل حتى ثلاث خانات عشرية / Quantity supports up to three decimals'),
  unit: z.string().trim().min(1).max(30),
  unit_price: z.number().int().min(0).max(maxEntryMinor),
});
export type InvoiceItem = z.infer<typeof invoiceItemSchema>;

export function invoiceLineTotal(item: Pick<InvoiceItem, 'quantity' | 'unit_price'>) {
  const scaled = Math.round(item.quantity * 1000);
  if (!Number.isSafeInteger(scaled) || scaled / 1000 !== item.quantity || item.quantity < 0 || item.quantity > 100_000_000 ||
    !Number.isSafeInteger(item.unit_price) || item.unit_price < 0 || item.unit_price > maxEntryMinor) return null;
  const result = (BigInt(scaled) * BigInt(item.unit_price) + 500n) / 1000n;
  return result <= BigInt(maxEntryMinor) ? Number(result) : null;
}

export function invoiceTotals(items: Array<Pick<InvoiceItem, 'quantity' | 'unit_price'>>) {
  if (!items.length || items.length > maxInvoiceItems) return null;
  let subtotal = 0;
  for (const item of items) {
    const total = invoiceLineTotal(item);
    if (total === null) return null;
    subtotal += total;
    if (subtotal > maxEntryMinor) return null;
  }
  const vat = Math.floor((subtotal * invoiceVatPercent + 50) / 100);
  const total = subtotal + vat;
  return total <= maxEntryMinor ? { subtotal, vat, total } : null;
}
