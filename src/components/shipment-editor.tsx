'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Trash2, X } from 'lucide-react';
import { containerStatusLabels, type Container, type Dataset, type Lang } from '@/lib/domain';
import { availableInvoiceItems } from '@/lib/manifest';
import { errorMessage, Field, translate, type RecordChange } from './forms';

type Quantities = Record<string, Record<number, string>>;

export function ShipmentEditor({ container, data, lang, close, save }: {
  container?: Container; data: Dataset; lang: Lang; close: () => void; save: (change: RecordChange) => Promise<void>;
}) {
  const t = translate(lang);
  const invoices = availableInvoiceItems(data, container?.id);
  const [quantities, setQuantities] = useState<Quantities>(() => Object.fromEntries(invoices
    .filter(({ items }) => items.some(item => item.assigned > 0))
    .map(({ entry, items }) => [entry.id, Object.fromEntries(items.map(item => [item.index, String(item.assigned)]))])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const identity = useRef(container?.id);

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);

  function addInvoice(id: string) {
    const invoice = invoices.find(({ entry }) => entry.id === id);
    if (!invoice) return;
    setQuantities(previous => ({
      ...previous,
      [id]: Object.fromEntries(invoice.items.map(item => [item.index, String(item.available)])),
    }));
  }

  function removeInvoice(id: string) {
    setQuantities(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? '').trim();
    try {
      const name = field('name');
      const destination = field('destination');
      const status = container ? field('status') as Container['status'] : 'preparing';
      if (!name || !destination) throw new Error(t('أدخل رقم الحاوية والوجهة.', 'Enter the container number and destination.'));
      if (data.containers.some(row => row.id !== identity.current && row.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(t('رقم الحاوية مسجّل مسبقًا.', 'The container number already exists.'));
      }
      const lines = Object.entries(quantities).flatMap(([entryId, values]) => {
        const invoice = invoices.find(({ entry }) => entry.id === entryId);
        const selected = Object.entries(values).flatMap(([index, value]) => {
          const quantity = Number(value);
          if (quantity === 0) return [];
          const itemIndex = Number(index);
          const item = invoice?.items.find(row => row.index === itemIndex);
          if (!item || quantity <= 0 || quantity > item.available || Math.round(quantity * 1000) / 1000 !== quantity) {
            throw new Error(t('راجع الكمية المتاحة في الفاتورة.', 'Check the available invoice quantity.'));
          }
          return [{ entry_id: entryId, item_index: itemIndex, quantity }];
        });
        if (!selected.length) throw new Error(t('حدد كمية أو أزل الفاتورة من الحمولة.', 'Enter a quantity or remove the invoice from the manifest.'));
        return selected;
      });
      if (status !== 'preparing' && !lines.length && !data.loads.some(load => load.container_id === container?.id)) {
        throw new Error(t('أضف حمولة قبل تسجيل الشحن.', 'Add cargo before recording shipment.'));
      }
      identity.current ??= crypto.randomUUID();
      await save({ type: 'manifest', value: { id: identity.current, name, destination, booking: field('booking'), status },
        lines, expected: container?.manifest_revision });
      close();
    } catch (problem) {
      setError(errorMessage(problem));
      setBusy(false);
    }
  }

  const unselected = invoices.filter(({ entry }) => !quantities[entry.id]);
  return <dialog ref={dialog} className="editor purchase-editor" aria-labelledby="shipment-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header className="dialog-head">
      <h2 id="shipment-title">{container ? t('تعديل الحاوية', 'Edit container') : t('حاوية جديدة', 'New container')}</h2>
      <button type="button" className="icon-btn" aria-label={t('إغلاق', 'Close')} onClick={close} disabled={busy}><X size={19} /></button>
    </header>
    <form onSubmit={submit}>
      <fieldset className="purchase-fields" disabled={busy}>
        <div className="form-grid">
          <Field title={t('رقم الحاوية', 'Container number')}><input name="name" defaultValue={container?.name} maxLength={80} required /></Field>
          <Field title={t('الوجهة', 'Destination')}><input name="destination" defaultValue={container?.destination} maxLength={120} required /></Field>
          <Field title={t('رقم الحجز (اختياري)', 'Booking reference (optional)')}><input name="booking" defaultValue={container?.booking} maxLength={100} /></Field>
          {container && <Field title={t('حالة الحاوية', 'Container status')}><select name="status" defaultValue={container.status}>
            {Object.entries(containerStatusLabels).map(([value, labels]) => <option key={value} value={value}>{t(labels[0], labels[1])}</option>)}
          </select></Field>}
        </div>
        <div className="manifest-picker">
          <Field title={t('إضافة فاتورة إلى الحمولة', 'Add invoice to manifest')}>
            <select value="" disabled={!unselected.length} onChange={event => addInvoice(event.target.value)}>
              <option value="">{unselected.length ? t('اختر فاتورة', 'Select invoice') : t('لا توجد فواتير متاحة', 'No available invoices')}</option>
              {unselected.map(({ entry }) => <option key={entry.id} value={entry.id}>{entry.invoice_number} · {entry.party} · {entry.date}</option>)}
            </select>
          </Field>
          {invoices.filter(({ entry }) => quantities[entry.id]).map(({ entry, items }) => <section className="purchase-item" key={entry.id}>
            <div className="manifest-invoice-head">
              <strong>{t('فاتورة', 'Invoice')} <bdi>{entry.invoice_number}</bdi> · {entry.party}</strong>
              <button type="button" className="icon-btn debt-delete" aria-label={t('إزالة الفاتورة من الحمولة', 'Remove invoice from manifest')} onClick={() => removeInvoice(entry.id)}><Trash2 size={16} /></button>
            </div>
            {items.map(item => <div className="manifest-item" key={item.index}>
              <div><strong>{item.name}</strong><small>{t('المتاح', 'Available')} <bdi>{item.available}</bdi> {item.unit}</small></div>
              <Field title={t('الكمية المشحونة', 'Quantity shipped')}>
                <input type="number" inputMode="decimal" min="0" max={item.available} step="0.001"
                  aria-label={t('الكمية المشحونة', 'Quantity shipped') + ' · ' + item.name}
                  value={quantities[entry.id][item.index] ?? '0'} onChange={event => {
                    const value = event.target.value;
                    setQuantities(previous => ({ ...previous, [entry.id]: { ...previous[entry.id], [item.index]: value } }));
                  }} />
              </Field>
            </div>)}
          </section>)}
        </div>
      </fieldset>
      {error && <p className="error-box" role="alert">{error}</p>}
      <footer className="dialog-actions">
        <button className="btn secondary" type="button" onClick={close} disabled={busy}>{t('رجوع', 'Back')}</button>
        <button className="btn primary" type="submit" disabled={busy}><Check size={17} />{busy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ', 'Save')}</button>
      </footer>
    </form>
  </dialog>;
}
