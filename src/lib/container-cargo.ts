import { type Dataset, type Entry } from './domain';
import { type containerCost } from './manifest';

export type CargoItem = {
  id: string; name: string; unit: string; quantity: number; cost: number;
  invoice?: Pick<Entry, 'invoice_number' | 'party' | 'date' | 'receipt_path'>;
};

export function containerCargo(data: Dataset, { invoiceLines, lines }: Pick<ReturnType<typeof containerCost>, 'invoiceLines' | 'lines'>): CargoItem[] {
  const entries = new Map(data.entries.map(entry => [entry.id, entry]));
  const products = new Map(data.products.map(product => [product.id, product]));
  const invoiced = invoiceLines.flatMap((line): CargoItem[] => {
    const invoice = entries.get(line.entry_id);
    const product = invoice?.invoice_items?.[line.item_index];
    if (!invoice || !product) return [];
    return [{ id: line.entry_id + '/' + line.item_index, name: product.name, unit: product.unit,
      quantity: line.quantity, cost: line.cost_sar, invoice }];
  }).sort((a, b) => (a.invoice?.date ?? '').localeCompare(b.invoice?.date ?? '') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return invoiced.concat(lines.flatMap(line => {
    const product = products.get(line.product_id);
    return product ? [{ id: line.id, name: product.name, unit: product.unit, quantity: line.quantity, cost: line.cost_sar }] : [];
  }));
}
