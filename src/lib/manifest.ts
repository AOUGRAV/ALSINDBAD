import { type Dataset } from './domain';

export function availableInvoiceItems(data: Dataset, containerId?: string) {
  const allocated = new Map<string, number>();
  const current = new Map<string, number>();
  for (const load of data.invoice_loads) {
    const key = load.entry_id + '/' + load.item_index;
    if (load.container_id === containerId) current.set(key, load.quantity);
    else allocated.set(key, (allocated.get(key) ?? 0) + Math.round(load.quantity * 1000));
  }
  return data.entries.filter(entry => entry.kind === 'purchase' && !entry.voided_at && entry.invoice_items)
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
    .flatMap(entry => {
      const items = (entry.invoice_items ?? []).flatMap((item, index) => {
        const key = entry.id + '/' + index;
        const available = (Math.round(item.quantity * 1000) - (allocated.get(key) ?? 0)) / 1000;
        return available > 0 ? [{ ...item, index, available, assigned: current.get(key) ?? 0 }] : [];
      });
      return items.length ? [{ entry, items }] : [];
    });
}
