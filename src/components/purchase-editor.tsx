'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Plus, ScanText, Trash2, X } from 'lucide-react';
import { currencies, minor, money, preparePurchaseInvoice, today, type Currency, type Dataset, type Entry, type Lang } from '@/lib/domain';
import { invoiceLineTotal, invoiceTotals, invoiceVatPercent, maxInvoiceItems } from '@/lib/purchases';
import { receiptAccept, receiptExtension } from '@/lib/receipt';
import { errorMessage, Field, translate, type PurchaseEditor, type RecordChange } from './forms';

type ItemFields = { id: number; name: string; quantity: string; unit: string; price: string };
const emptyItem = (id: number): ItemFields => ({ id, name: '', quantity: '1', unit: '', price: '' });

export function PurchaseEditorDialog({ editor, data, lang, close, save }: {
  editor: PurchaseEditor; data: Dataset; lang: Lang; close: () => void; save: (change: RecordChange) => Promise<void>;
}) {
  const t = translate(lang);
  const { original } = editor;
  const [items, setItems] = useState<ItemFields[]>(() => original?.invoice_items?.map((item, id) => ({
    id, name: item.name, quantity: String(item.quantity), unit: item.unit, price: (item.unit_price / 100).toFixed(2),
  })) ?? [emptyItem(0)]);
  const nextId = useRef(items.length);
  const [party, setParty] = useState(original?.party ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState(original?.invoice_number ?? '');
  const [date, setDate] = useState(original?.date ?? today());
  const [currency, setCurrency] = useState<Currency>(original?.currency ?? 'SAR');
  const [partial, setPartial] = useState(Boolean(original && original.paid < original.amount));
  const [attachment, setAttachment] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanStatus, setScanStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const identity = useRef<Pick<Entry, 'id' | 'created_at'> | null>(null);
  const invoiceItems = items.map(item => ({ name: item.name.trim(), quantity: Number(item.quantity), unit: item.unit.trim(), unit_price: minor(item.price) }));
  const totals = invoiceTotals(invoiceItems);
  const blocked = busy || reading;

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);

  function updateItem(id: number, field: keyof Omit<ItemFields, 'id'>, value: string) {
    setItems(rows => rows.map(item => item.id === id ? { ...item, [field]: value } : item));
  }

  async function readInvoice() {
    if (!attachment || blocked) return;
    setScanStatus('');
    setReading(true);
    try {
      const { scanInvoice } = await import('@/lib/scan-invoice');
      const { fields } = await scanInvoice(attachment, () => {});
      if (fields.number && !invoiceNumber) setInvoiceNumber(fields.number);
      if (fields.supplier && !party) setParty(fields.supplier);
      if (fields.date && !original && date === today()) setDate(fields.date);
      setScanStatus(fields.number || fields.date || fields.supplier
        ? t('راجع بيانات الفاتورة وأدخل المنتجات والأسعار.', 'Review the invoice details and enter its products and prices.')
        : t('تعذّر تحديد بيانات الفاتورة. أدخلها يدويًا.', 'The invoice details could not be read. Enter them manually.'));
    } catch {
      setScanStatus(t('تعذّرت قراءة الملف. أدخل البيانات يدويًا.', 'Could not read the file. Enter the details manually.'));
    } finally { setReading(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '').trim();
    setBusy(true);
    setError('');
    try {
      identity.current ??= original ? { id: original.id, created_at: original.created_at } :
        { id: crypto.randomUUID(), created_at: new Date().toISOString() };
      const number = invoiceNumber.trim();
      const entry = preparePurchaseInvoice({
        ...identity.current, party, date, invoice_number: number, invoice_items: invoiceItems, currency,
        category: original?.category ?? t('مشتريات', 'Purchases'),
        description: t('فاتورة شراء ', 'Purchase invoice ') + number,
        method: value('method') as Entry['method'], rate: currency === 'SAR' ? 1 : Number(value('rate')),
        paid: partial ? minor(value('paid')) : undefined,
      }, data, original);
      if (attachment) receiptExtension(attachment);
      await save({ type: 'entry', value: entry, original, receipt: attachment ?? undefined,
        reason: original ? t('تعديل فاتورة مشتريات', 'Edited purchase invoice') : '' });
      close();
    } catch (problem) {
      setError(problem && typeof problem === 'object' && 'issues' in problem && Array.isArray(problem.issues)
        ? String(problem.issues[0]?.message) : errorMessage(problem));
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="editor purchase-editor" aria-labelledby="purchase-title" onCancel={event => { event.preventDefault(); if (!blocked) close(); }}>
    <header className="dialog-head">
      <h2 id="purchase-title">{original ? t('تعديل فاتورة شراء', 'Edit purchase invoice') : t('فاتورة شراء جديدة', 'New purchase invoice')}</h2>
      <button className="icon-btn" type="button" aria-label={t('إغلاق', 'Close')} onClick={close} disabled={blocked}><X size={19} /></button>
    </header>
    <form onSubmit={submit}>
      <fieldset className="purchase-fields" disabled={blocked}>
        <div className="form-grid">
          <Field title={t('اشتريت من', 'Purchased from')} wide><input value={party} onChange={event => setParty(event.target.value)} placeholder={t('شركة، محل أو شخص', 'Company, shop, or person')} maxLength={120} required /></Field>
          <Field title={t('رقم الفاتورة', 'Invoice number')}><input value={invoiceNumber} onChange={event => setInvoiceNumber(event.target.value)} maxLength={80} required /></Field>
          <Field title={t('تاريخ الفاتورة', 'Invoice date')}><input type="date" value={date} onChange={event => setDate(event.target.value)} required /></Field>
          <Field title={t('طريقة الدفع', 'Payment method')}><select name="method" defaultValue={original?.method ?? 'cash'}>
            <option value="cash">{t('نقدي', 'Cash')}</option><option value="bank">{t('تحويل بنكي', 'Bank transfer')}</option><option value="card">{t('بطاقة', 'Card')}</option>
          </select></Field>
          <Field title={t('العملة', 'Currency')}><select value={currency} onChange={event => setCurrency(event.target.value as Currency)}>
            {currencies.map(code => <option key={code} value={code}>{code === 'SAR' ? t('ريال سعودي', 'Saudi riyal') : code}</option>)}
          </select></Field>
          {currency !== 'SAR' && <Field title={t('سعر صرف 1', 'SAR per 1') + ' ' + currency + (lang === 'ar' ? ' بالريال' : '')} wide>
            <input key={currency} name="rate" type="number" inputMode="decimal" min="0.000001" max="10000" step="0.000001"
              defaultValue={original?.currency === currency ? original.rate : undefined} required />
          </Field>}
        </div>
        <div className="purchase-items-head">
          <h3>{t('المنتجات', 'Products')}</h3>
          <button type="button" className="btn secondary" disabled={items.length >= maxInvoiceItems} onClick={() => {
            const item = emptyItem(nextId.current++);
            setItems(rows => [...rows, item]);
          }}><Plus size={16} />{t('إضافة منتج', 'Add product')}</button>
        </div>
        <div className="purchase-items">
          {items.map((item, index) => {
            const total = invoiceLineTotal(invoiceItems[index]);
            return <section className="purchase-item" key={item.id} aria-label={t('منتج ', 'Product ') + (index + 1)}>
              <div className="purchase-item-top">
                <Field title={t('اسم المنتج', 'Product name')}><input value={item.name} onChange={event => updateItem(item.id, 'name', event.target.value)} maxLength={140} required /></Field>
                {items.length > 1 && <button className="icon-btn debt-delete" type="button" aria-label={t('حذف المنتج ', 'Remove product ') + (index + 1)}
                  onClick={() => setItems(rows => rows.filter(row => row.id !== item.id))}><Trash2 size={17} /></button>}
              </div>
              <div className="purchase-item-amounts">
                <Field title={t('الكمية', 'Quantity')}><input type="number" inputMode="decimal" min="0.001" max="100000000" step="0.001"
                  value={item.quantity} onChange={event => updateItem(item.id, 'quantity', event.target.value)} required /></Field>
                <Field title={t('الوحدة', 'Unit')}><input value={item.unit} onChange={event => updateItem(item.id, 'unit', event.target.value)}
                  placeholder={t('مثال: كرتون', 'e.g. carton')} maxLength={30} required /></Field>
                <Field title={t('سعر الوحدة قبل الضريبة', 'Unit price before VAT')}><input type="number" inputMode="decimal" min="0" max="1000000000" step="0.01"
                  value={item.price} onChange={event => updateItem(item.id, 'price', event.target.value)} required /></Field>
              </div>
              <div className="purchase-item-total"><span>{t('مجموع المنتج', 'Line total')}</span><bdi>{total === null ? '—' : money(total, currency, lang)}</bdi></div>
            </section>;
          })}
        </div>
        <div className="purchase-totals" aria-live="polite">
          <div><span>{t('قبل الضريبة', 'Subtotal before VAT')}</span><bdi>{totals ? money(totals.subtotal, currency, lang) : '—'}</bdi></div>
          <div><span>{t('الضريبة', 'VAT')} <bdi>{invoiceVatPercent}%</bdi></span><bdi>{totals ? money(totals.vat, currency, lang) : '—'}</bdi></div>
          <div><strong>{t('الإجمالي شامل الضريبة', 'Total including VAT')}</strong><strong><bdi>{totals ? money(totals.total, currency, lang) : '—'}</bdi></strong></div>
        </div>
        <details className="debt-more" open={partial || undefined}>
          <summary>{t('مرفق أو دفعة جزئية', 'Attachment or partial payment')}</summary>
          <div className="form-grid">
            <Field title={original?.receipt_path ? t('استبدال صورة الفاتورة', 'Replace invoice attachment') : t('إرفاق صورة أو PDF', 'Attach image or PDF')} wide>
              <input type="file" accept={receiptAccept} onChange={event => {
                setAttachment(event.target.files?.[0] ?? null);
                setScanStatus('');
              }} />
            </Field>
            {attachment && <div className="field-wide actions"><button type="button" className="btn secondary" onClick={readInvoice}><ScanText size={16} />{reading ? t('جارٍ القراءة…', 'Reading…') : t('قراءة بيانات الفاتورة', 'Read invoice details')}</button>
              {scanStatus && <p className="muted" role="status">{scanStatus}</p>}</div>}
            <label className="field-wide check-field"><input type="checkbox" checked={partial} onChange={event => setPartial(event.target.checked)} />{t('دفعت جزءًا من الفاتورة أو لم أدفع بعد', 'I paid part of the invoice or have not paid yet')}</label>
            {partial && <Field title={t('المبلغ المدفوع', 'Amount paid')} wide><input name="paid" type="number" inputMode="decimal" min="0"
              max={totals ? totals.total / 100 : undefined} step="0.01" defaultValue={original ? original.paid / 100 : 0} required /></Field>}
          </div>
        </details>
      </fieldset>
      {error && <p className="error-box" role="alert">{error}</p>}
      <footer className="dialog-actions">
        <button type="button" className="btn secondary" disabled={blocked} onClick={close}>{t('رجوع', 'Back')}</button>
        <button className="btn primary" type="submit" disabled={blocked}><Check size={17} />{busy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ الفاتورة', 'Save invoice')}</button>
      </footer>
    </form>
  </dialog>;
}
