'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Paperclip, ScanText, X } from 'lucide-react';
import { currencies, kinds, kindLabels, debtBalance, inventory, minor, money, today, toSar, validateEntry, validateLoad, type Container, type Currency, type Dataset, type Entry, type Kind, type Lang, type LoadDraft, type Product } from '@/lib/domain';
import { receiptAccept, receiptExtension } from '@/lib/receipt';

export const translate = (lang: Lang) => (ar: string, en: string) => lang === 'ar' ? ar : en;
export const errorMessage = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
const field = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const newRecord = () => ({ id: crypto.randomUUID(), created_at: new Date().toISOString() });
export type RecordEditor = { type: 'entry'; kind?: Kind; container?: Container; original?: Entry } |
  { type: 'product' } | { type: 'container' } | { type: 'load'; container: Container } |
  { type: 'history'; original: Entry } | { type: 'void'; original: Entry; debtItem?: 'debt' | 'payment' };
export type DebtEditor = { type: 'debt' } | { type: 'settlement'; debt: Entry };
export type Editor = RecordEditor | DebtEditor;
export type RecordChange = { type: 'entry'; value: Entry; receipt?: File; original?: Entry; reason: string } |
  { type: 'product'; value: Product } | { type: 'container'; value: Container } | { type: 'load'; value: LoadDraft } |
  { type: 'void'; original: Entry; reason: string };
type Scan = Awaited<ReturnType<typeof import('@/lib/scan-invoice').scanInvoice>>;

export function Field({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) {
  return <label className={'field' + (wide ? ' field-wide' : '')}><span>{title}</span>{children}</label>;
}

export function EditorDialog({ editor, data, lang, close, save, onReceipt }: {
  editor: RecordEditor; data: Dataset; lang: Lang; close: () => void; save: (change: RecordChange) => Promise<void>; onReceipt: (path: string) => void;
}) {
  const t = translate(lang);
  const dialog = useRef<HTMLDialogElement>(null);
  const identityRef = useRef<ReturnType<typeof newRecord> | null>(null);
  const entry = editor.type === 'entry' ? editor : undefined;
  const original = entry?.original;
  const debt = original?.settles_id ? data.entries.find(row => row.id === original.settles_id) : undefined;
  const debtItem = editor.type === 'void' ? editor.debtItem : undefined;
  const deleteTitle = debtItem === 'debt' ? t('حذف الدين', 'Delete debt') : t('حذف الدفعة', 'Delete payment');
  const [kind, setKind] = useState<Kind>(original?.kind ?? entry?.kind ?? 'expense');
  const [currency, setCurrency] = useState<Currency>(original?.currency ?? debt?.currency ?? 'SAR');
  const [scope, setScope] = useState<Entry['scope']>(original?.scope ?? debt?.scope ?? 'business');
  const [date, setDate] = useState(original?.date ?? today());
  const [party, setParty] = useState(original?.party ?? '');
  const [description, setDescription] = useState(original?.description ?? (debt ? t(...kindLabels[kind]) : ''));
  const [amount, setAmount] = useState(original ? (original.amount / 100).toFixed(2) : '');
  const [rate, setRate] = useState(original ? String(original.rate) : '');
  const [file, setFile] = useState<File | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [reading, setReading] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);

  const title = editor.type === 'product' ? t('إضافة صنف', 'Add product') : editor.type === 'container' ?
    t('حاوية جديدة', 'New container') : editor.type === 'load' ? t('تحميل بضاعة', 'Load stock') :
    editor.type === 'void' ? (debtItem ? deleteTitle : t('إلغاء الحركة', 'Void transaction')) : editor.type === 'history' ? t('سجل التغييرات', 'Change history') :
    original ? t('تصحيح الحركة', 'Correct transaction') : debt ? t('تسجيل دفعة', 'Record settlement') : t('عملية جديدة', 'New transaction');
  const unavailable = busy || reading;
  const remaining = debt ? debtBalance(debt, data.entries.filter(row => row.id !== original?.id)) : 0;

  async function readInvoice() {
    if (!file || unavailable) return;
    setScan(null);
    setScanMessage('');
    setReading(true);
    setProgress(0);
    try {
      const { scanInvoice } = await import('@/lib/scan-invoice');
      const result = await scanInvoice(file, setProgress);
      setScan(result);
      if (!Object.values(result.fields).some(Boolean)) setScanMessage(t('تعذّر تحديد الحقول. راجع النص أو أكمل بيانات الفاتورة يدويًا.', 'No fields could be identified. Review the text or enter the invoice details manually.'));
    } catch {
      setScanMessage(t('تعذّرت قراءة الملف. جرّب صورة أوضح أو أدخل البيانات يدويًا.', 'Could not read the file. Try a clearer image or enter the details manually.'));
    } finally { setReading(false); }
  }

  function applyInvoice() {
    if (!scan) return;
    const values = scan.fields;
    if (values.date) setDate(values.date);
    if (values.supplier && !debt) setParty(values.supplier);
    if (values.total) setAmount(values.total);
    if (values.currency && !debt && values.currency !== currency) {
      setCurrency(values.currency);
      setRate('');
    }
    if (values.number && !description.trim()) setDescription(t('فاتورة ', 'Invoice ') + values.number);
    setScanMessage(t('أُدخلت البيانات المقترحة. راجعها قبل الحفظ.', 'Suggested fields applied. Review them before saving.'));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unavailable || editor.type === 'history') return;
    const form = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      const identity = original ? { id: original.id, created_at: original.created_at } : identityRef.current ??= newRecord();
      if (editor.type === 'entry') {
        const product = data.products.find(p => p.id === field(form, 'product'));
        const record = validateEntry({
          ...identity, kind, currency, scope, date, party: debt?.party ?? party,
          description, category: debt?.category ?? (kind === 'purchase' ? product?.category : field(form, 'category')),
          amount: minor(amount), paid: kind === 'purchase' ? minor(field(form, 'paid')) : minor(amount),
          rate: currency === 'SAR' ? 1 : Number(rate), method: field(form, 'method'),
          product_id: kind === 'purchase' ? product?.id ?? null : null,
          quantity: kind === 'purchase' ? Number(field(form, 'quantity')) : 0, settles_id: debt?.id ?? null,
          container_id: kind === 'expense' && scope === 'business' ? field(form, 'container') || null : null,
          receipt_path: original?.receipt_path ?? null, opening: form.has('opening'),
        }, data, original);
        const reason = field(form, 'reason');
        if (original && !reason) throw new Error(t('اكتب سبب التصحيح.', 'Enter the correction reason.'));
        if (file) receiptExtension(file);
        await save({ type: 'entry', value: record, receipt: file ?? undefined, original, reason });
      } else if (editor.type === 'product') {
        const name = field(form, 'name'), category = field(form, 'category'), unit = field(form, 'unit');
        if (!name || !category || !unit) throw new Error(t('أكمل بيانات الصنف', 'Complete the product details'));
        await save({ type: 'product', value: { ...identity, name, category, unit, expiry: field(form, 'expiry') || null } });
      } else if (editor.type === 'container') {
        const name = field(form, 'name'), destination = field(form, 'destination');
        if (!name || !destination) throw new Error(t('أكمل بيانات الحاوية', 'Complete the container details'));
        if (data.containers.some(c => c.name.toLowerCase() === name.toLowerCase())) throw new Error(t('رقم الحاوية مسجل مسبقًا', 'Container already exists'));
        await save({ type: 'container', value: { ...identity, name, destination, booking: field(form, 'booking'), status: 'preparing' } });
      } else if (editor.type === 'load') {
        await save({ type: 'load', value: validateLoad({ ...identity, container_id: editor.container.id,
          product_id: field(form, 'product'), quantity: Number(field(form, 'quantity')) }, data) });
      } else {
        const reason = debtItem ? t('حُذفت من شاشة الديون', 'Removed from the debts screen') : field(form, 'reason');
        if (!reason) throw new Error(t('اكتب سبب الإلغاء.', 'Enter the reason for voiding.'));
        await save({ type: 'void', original: editor.original, reason });
      }
      close();
    } catch (problem) {
      setError(problem && typeof problem === 'object' && 'issues' in problem && Array.isArray(problem.issues)
        ? String(problem.issues[0]?.message) : errorMessage(problem));
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="editor" aria-labelledby="editor-title" onCancel={event => { event.preventDefault(); if (!unavailable) close(); }}>
    <header className="dialog-head">
      <div><span className="eyebrow">ALSINDBAD / JED</span><h2 id="editor-title">{title}</h2></div>
      <button type="button" className="icon-btn" aria-label={t('إغلاق', 'Close')} onClick={close} disabled={unavailable}><X size={19} /></button>
    </header>
    {editor.type === 'history' ? <div className="history-list">
      <p className="form-note">{editor.original.description} · {editor.original.party}</p>
      {data.history.filter(item => item.entry_id === editor.original.id).sort((a, b) => b.revision - a.revision).map(item => <article className="history-item" key={item.revision}>
        <div className="split-line"><strong>{item.action === 'void' ? t('إلغاء', 'Voided') : t('تصحيح', 'Corrected')}</strong><bdi>{new Date(item.recorded_at).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-GB', { timeZone: 'Asia/Riyadh' })}</bdi></div>
        <p>{item.reason}</p>
        <details><summary>{t('الحركة قبل التغيير', 'Transaction before the change')}</summary>
          <p>{item.previous.description} · {item.previous.party} · {item.previous.category}</p>
          <p><bdi>{item.previous.date}</bdi> · <bdi>{money(item.previous.amount, item.previous.currency, lang)}</bdi> · {t('سعر الصرف', 'FX rate')} <bdi>{item.previous.rate}</bdi></p>
          {item.previous.kind === 'purchase' && <p>{t('المدفوع', 'Paid')} <bdi>{money(item.previous.paid, item.previous.currency, lang)}</bdi> · {t('الكمية', 'Quantity')} {item.previous.quantity}</p>}
          {item.previous.receipt_path && <button className="btn secondary" type="button" onClick={() => onReceipt(item.previous.receipt_path!)}>{t('تنزيل الفاتورة السابقة', 'Download previous receipt')}</button>}
        </details>
      </article>)}
    </div> : <form onSubmit={submit}>
      <div className="form-grid">
        {editor.type === 'entry' && <>
          {debt ? <p className="field-wide form-note">{debt.party} · {t('المتاح لهذه الدفعة', 'Available for this payment')}: <bdi>{money(remaining, debt.currency, lang)}</bdi></p> :
            <Field title={t('نوع العملية', 'Transaction type')}><select value={kind} onChange={e => setKind(e.target.value as Kind)} disabled={Boolean(original)}>
              {kinds.filter(k => k !== 'collect' && k !== 'repay').map(k => <option key={k} value={k}>{t(...kindLabels[k])}</option>)}
            </select></Field>}
          <Field title={t('التاريخ', 'Date')}><input type="date" name="date" value={date} onChange={event => setDate(event.target.value)} min={debt?.date} required /></Field>
          {!debt && <Field title={t('المورد أو الجهة', 'Supplier or party')}><input name="party" value={party} onChange={event => setParty(event.target.value)} maxLength={120} placeholder={t('اسم الجهة', 'Party name')} required /></Field>}
          {!debt && <Field title={t('نطاق العملية', 'Scope')}><select value={scope} onChange={e => setScope(e.target.value as Entry['scope'])}><option value="business">{t('تجاري', 'Business')}</option><option value="personal">{t('شخصي', 'Personal')}</option></select></Field>}
          <Field title={t('الوصف', 'Description')} wide><input name="description" value={description} onChange={event => setDescription(event.target.value)} maxLength={500} placeholder={t('مثال: شراء بضاعة للحاوية الأولى', 'e.g. Stock for the first shipment')} required /></Field>
          {(kind === 'borrow' || kind === 'lend') && <label className="field-wide check-field"><input type="checkbox" name="opening" defaultChecked={original?.opening} />{t('دين سابق قبل بدء التسجيل (دون حركة نقدية)', 'Opening debt (no new cash movement)')}</label>}
          {kind === 'purchase' && <>
            <Field title={t('الصنف', 'Product')}><select name="product" required defaultValue={original?.product_id ?? ''}><option value="" disabled>{t('اختر صنفًا', 'Select product')}</option>{data.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field title={t('الكمية', 'Quantity')}><input name="quantity" defaultValue={original?.quantity} type="number" min="1" max="100000000" step="1" inputMode="numeric" required /></Field>
            {!data.products.length && <p className="form-note field-wide">{t('أضف صنفًا من صفحة المخزون أولًا.', 'Add a product in Inventory first.')}</p>}
          </>}
          {!debt && kind !== 'purchase' && <Field title={t('التصنيف', 'Category')}><input name="category" defaultValue={original?.category} maxLength={80} list="categories" placeholder={t('مثال: إيجار سيارة', 'e.g. Vehicle rental')} required />
            <datalist id="categories">{[t('إيجار سيارة', 'Vehicle rental'), t('وقود', 'Fuel'), t('سكن ومكتب', 'Accommodation and office'), t('إكراميات', 'Tips'), t('أكل وشرب', 'Food and drink'), t('تمويل مؤقت', 'Temporary funding'), t('نقل وشحن', 'Freight'), t('معدات', 'Equipment'), ...new Set(data.entries.map(e => e.category))].map((value, index) => <option key={index} value={value} />)}</datalist>
          </Field>}
          <Field title={t('العملة', 'Currency')}><select value={currency} onChange={e => setCurrency(e.target.value as Currency)} disabled={Boolean(debt)}>{currencies.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field title={t('المبلغ الإجمالي', 'Total amount')}><input type="number" inputMode="decimal" min="0.01" max={debt ? remaining / 100 : 1000000000} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required /></Field>
          {kind === 'purchase' && <Field title={t('المبلغ المدفوع', 'Amount paid')}><input name="paid" defaultValue={original ? original.paid / 100 : undefined} type="number" inputMode="decimal" min="0" max={amount || undefined} step="0.01" required /></Field>}
          {currency !== 'SAR' && <Field title={t('ريال لكل وحدة من العملة', 'SAR per unit of currency')}><input type="number" inputMode="decimal" min="0.000001" max="10000" step="0.000001" value={rate} onChange={e => setRate(e.target.value)} placeholder={debt ? String(debt.rate) : undefined} required /></Field>}
          <Field title={t('طريقة الدفع', 'Payment method')}><select name="method" defaultValue={original?.method ?? 'bank'}><option value="bank">{t('تحويل بنكي', 'Bank transfer')}</option><option value="cash">{t('نقدًا', 'Cash')}</option><option value="card">{t('بطاقة', 'Card')}</option></select></Field>
          {kind === 'expense' && scope === 'business' && data.containers.length > 0 && <Field title={t('ربط بحاوية (اختياري)', 'Link to container (optional)')}><select name="container" defaultValue={original?.container_id ?? entry?.container?.id ?? ''}><option value="">{t('بدون حاوية', 'No container')}</option>{data.containers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          {currency !== 'SAR' && Number(amount) > 0 && Number(amount) <= 1000000000 && Number(rate) > 0 && Number(rate) <= 10000 && <p className="form-note field-wide">{t('ما يعادله بالريال', 'SAR equivalent')}: <bdi>{money(toSar(minor(amount), Number(rate)), 'SAR', lang)}</bdi></p>}
          <Field title={original?.receipt_path ? t('استبدال الفاتورة المرفقة (اختياري)', 'Replace attached receipt (optional)') : t('فاتورة أو إيصال (اختياري)', 'Invoice or receipt (optional)')} wide>
            <div className="file-field"><Paperclip size={16} /><input name="receipt" type="file" accept={receiptAccept} disabled={unavailable} onChange={event => {
              setFile(event.target.files?.[0] ?? null);
              setScan(null);
              setScanMessage('');
            }} /></div>
          </Field>
          {file && !debt && <div className="field-wide receipt-scan">
            <button type="button" className="btn secondary" disabled={unavailable} onClick={readInvoice}><ScanText size={17} />{reading ? t('جارٍ قراءة الفاتورة…', 'Reading invoice…') : t('قراءة الفاتورة', 'Read invoice')}</button>
            {reading && <progress max={100} value={progress} aria-label={t('تقدم قراءة الفاتورة', 'Invoice scanning progress')} />}
            {scan && Object.values(scan.fields).some(Boolean) && <div className="scan-result">
              <strong>{t('البيانات المقترحة', 'Suggested fields')}</strong>
              <p>{[scan.fields.supplier, scan.fields.number, scan.fields.date, [scan.fields.total, scan.fields.currency].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</p>
              <button type="button" className="btn secondary" disabled={unavailable} onClick={applyInvoice}>{t('استخدام البيانات المقترحة', 'Apply suggestions')}</button>
            </div>}
            {scan?.text && <details className="detail"><summary>{t('النص المقروء', 'Recognized text')} · {scan.pagesRead}/{scan.pageCount}</summary><pre dir="auto">{scan.text}</pre></details>}
            {scanMessage && <p role="status">{scanMessage}</p>}
          </div>}
          {original && <Field title={t('سبب التصحيح', 'Correction reason')} wide><input name="reason" maxLength={500} required /></Field>}
        </>}
        {editor.type === 'product' && <>
          <Field title={t('اسم الصنف', 'Product name')} wide><input name="name" maxLength={140} required /></Field>
          <Field title={t('التصنيف', 'Category')}><input name="category" maxLength={80} placeholder={t('مواد غذائية', 'Food')} required /></Field>
          <Field title={t('وحدة القياس', 'Unit')}><input name="unit" maxLength={30} placeholder={t('كرتون', 'Carton')} required /></Field>
          <Field title={t('تاريخ الصلاحية (اختياري)', 'Expiry date (optional)')}><input name="expiry" type="date" /></Field>
        </>}
        {editor.type === 'container' && <>
          <Field title={t('رقم الحاوية', 'Container number')}><input name="name" placeholder="JED–002" maxLength={80} required /></Field>
          <Field title={t('الوجهة', 'Destination')}><input name="destination" maxLength={120} required /></Field>
          <Field title={t('رقم الحجز (اختياري)', 'Booking reference (optional)')} wide><input name="booking" maxLength={100} /></Field>
        </>}
        {editor.type === 'load' && <>
          <p className="form-note field-wide">{editor.container.name} · {editor.container.destination}</p>
          <Field title={t('الصنف', 'Product')}><select name="product" required defaultValue=""><option value="" disabled>{t('اختر صنفًا', 'Select product')}</option>{data.products.filter(p => inventory(data, p.id).remaining > 0).map(p => <option value={p.id} key={p.id}>{p.name} · {inventory(data, p.id).remaining} {p.unit}</option>)}</select></Field>
          <Field title={t('الكمية المحملة', 'Quantity loaded')}><input name="quantity" type="number" min="1" max="100000000" step="1" inputMode="numeric" required /></Field>
        </>}
        {editor.type === 'void' && <>
          <p className="form-note field-wide">{debtItem ? editor.original.party : editor.original.description} · <bdi>{money(editor.original.amount, editor.original.currency, lang)}</bdi></p>
          <p className="field-wide muted">{debtItem === 'debt'
            ? t('يُحذف الدين من القائمة والأرصدة، وتبقى نسخة في سجل التغييرات.', 'The debt is removed from the list and balances, and retained in the change history.')
            : debtItem === 'payment'
              ? t('ترجع قيمة الدفعة إلى المبلغ المتبقي، وتبقى نسخة في سجل التغييرات.', 'The payment amount returns to the outstanding balance and remains in the change history.')
              : t('تُستبعد الحركة من الأرصدة والتقارير مع إبقائها في سجل التغييرات.', 'The transaction is excluded from balances and reports and retained in the change history.')}</p>
          {!debtItem && <Field title={t('سبب الإلغاء', 'Reason for voiding')} wide><input name="reason" maxLength={500} required /></Field>}
        </>}
      </div>
      {error && <p className="error-box" role="alert">{error}</p>}
      <footer className="dialog-actions">
        <button className="btn secondary" type="button" onClick={close} disabled={unavailable}>{t('رجوع', 'Back')}</button>
        <button className={'btn ' + (editor.type === 'void' ? 'danger' : 'primary')} type="submit" disabled={unavailable}><Check size={17} />{busy ? t('جارٍ الحفظ…', 'Saving…') : editor.type === 'void' ? (debtItem ? deleteTitle : t('تأكيد إلغاء الحركة', 'Void transaction')) : t('حفظ', 'Save')}</button>
      </footer>
    </form>}
  </dialog>;
}
