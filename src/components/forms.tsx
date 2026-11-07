'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Paperclip, X } from 'lucide-react';
import { currencies, kinds, kindLabels, debtBalance, inventory, minor, money, today, toSar, validateEntry, validateLoad, type Container, type Currency, type Dataset, type Entry, type Kind, type Lang, type Load, type Product } from '@/lib/domain';

export const translate = (lang: Lang) => (ar: string, en: string) => lang === 'ar' ? ar : en;
export const errorMessage = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
const field = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const newRecord = () => ({ id: crypto.randomUUID(), created_at: new Date().toISOString() });
export type Editor = { type: 'entry'; kind?: Kind; debt?: Entry; container?: Container } |
  { type: 'product' } | { type: 'container' } | { type: 'load'; container: Container };
export type RecordChange = { type: 'entry'; value: Entry; receipt?: File } |
  { type: 'product'; value: Product } | { type: 'container'; value: Container } | { type: 'load'; value: Load };

function Field({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) {
  return <label className={'field' + (wide ? ' field-wide' : '')}><span>{title}</span>{children}</label>;
}

export function EditorDialog({ editor, data, lang, demo, close, save }: {
  editor: Editor; data: Dataset; lang: Lang; demo: boolean; close: () => void; save: (change: RecordChange) => Promise<void>;
}) {
  const t = translate(lang);
  const dialog = useRef<HTMLDialogElement>(null);
  const identityRef = useRef<ReturnType<typeof newRecord> | null>(null);
  const entry = editor.type === 'entry' ? editor : undefined;
  const debt = entry?.debt;
  const [kind, setKind] = useState<Kind>(entry?.kind ?? 'expense');
  const [currency, setCurrency] = useState<Currency>(debt?.currency ?? 'SAR');
  const [scope, setScope] = useState<Entry['scope']>(debt?.scope ?? 'business');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);

  const title = editor.type === 'product' ? t('إضافة صنف', 'Add product') : editor.type === 'container' ?
    t('حاوية جديدة', 'New container') : editor.type === 'load' ? t('تحميل بضاعة', 'Load stock') :
    debt ? t('تسجيل دفعة', 'Record settlement') : t('عملية جديدة', 'New transaction');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      const identity = identityRef.current ??= newRecord();
      if (editor.type === 'entry') {
        const product = data.products.find(p => p.id === field(form, 'product'));
        const record = validateEntry({
          ...identity, kind, currency, scope, date: field(form, 'date'), party: debt?.party ?? field(form, 'party'),
          description: field(form, 'description'), category: debt?.category ?? (kind === 'purchase' ? product?.category : field(form, 'category')),
          amount: minor(amount), paid: kind === 'purchase' ? minor(field(form, 'paid')) : minor(amount),
          rate: currency === 'SAR' ? 1 : Number(rate), method: field(form, 'method'),
          product_id: kind === 'purchase' ? product?.id ?? null : null,
          quantity: kind === 'purchase' ? Number(field(form, 'quantity')) : 0, settles_id: debt?.id ?? null,
          container_id: kind === 'expense' && scope === 'business' ? field(form, 'container') || null : null,
          receipt_path: null,
        }, data);
        const receipt = form.get('receipt');
        await save({ type: 'entry', value: record, receipt: receipt instanceof File && receipt.size ? receipt : undefined });
      } else if (editor.type === 'product') {
        const name = field(form, 'name'), category = field(form, 'category'), unit = field(form, 'unit');
        if (!name || !category || !unit) throw new Error(t('أكمل بيانات الصنف', 'Complete the product details'));
        await save({ type: 'product', value: { ...identity, name, category, unit, expiry: field(form, 'expiry') || null } });
      } else if (editor.type === 'container') {
        const name = field(form, 'name'), destination = field(form, 'destination');
        if (!name || !destination) throw new Error(t('أكمل بيانات الحاوية', 'Complete the container details'));
        if (data.containers.some(c => c.name.toLowerCase() === name.toLowerCase())) throw new Error(t('رقم الحاوية مسجل مسبقًا', 'Container already exists'));
        await save({ type: 'container', value: { ...identity, name, destination, booking: field(form, 'booking'), status: 'preparing' } });
      } else {
        await save({ type: 'load', value: validateLoad({ ...identity, container_id: editor.container.id,
          product_id: field(form, 'product'), quantity: Number(field(form, 'quantity')) }, data) });
      }
      close();
    } catch (problem) {
      setError(problem && typeof problem === 'object' && 'issues' in problem && Array.isArray(problem.issues)
        ? String(problem.issues[0]?.message) : errorMessage(problem));
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="editor" aria-labelledby="editor-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header className="dialog-head">
      <div><span className="eyebrow">ALSINDBAD / JED</span><h2 id="editor-title">{title}</h2></div>
      <button type="button" className="icon-btn" aria-label={t('إغلاق', 'Close')} onClick={close} disabled={busy}><X size={19} /></button>
    </header>
    <form onSubmit={submit}>
      <div className="form-grid">
        {editor.type === 'entry' && <>
          {debt ? <p className="field-wide form-note">{debt.party} · {t('المتبقي', 'Remaining')}: <bdi>{money(debtBalance(debt, data.entries), debt.currency, lang)}</bdi></p> :
            <Field title={t('نوع العملية', 'Transaction type')}><select value={kind} onChange={e => setKind(e.target.value as Kind)}>
              {kinds.filter(k => k !== 'collect' && k !== 'repay').map(k => <option key={k} value={k}>{t(...kindLabels[k])}</option>)}
            </select></Field>}
          <Field title={t('التاريخ', 'Date')}><input type="date" name="date" defaultValue={today()} min={debt?.date} required /></Field>
          {!debt && <Field title={t('المورد أو الجهة', 'Supplier or party')}><input name="party" maxLength={120} placeholder={t('اسم الجهة', 'Party name')} required /></Field>}
          {!debt && <Field title={t('نطاق العملية', 'Scope')}><select value={scope} onChange={e => setScope(e.target.value as Entry['scope'])}><option value="business">{t('تجاري', 'Business')}</option><option value="personal">{t('شخصي', 'Personal')}</option></select></Field>}
          <Field title={t('الوصف', 'Description')} wide><input name="description" defaultValue={debt ? t(...kindLabels[kind]) : ''} maxLength={500} placeholder={t('مثال: شراء بضاعة للحاوية الأولى', 'e.g. Stock for the first shipment')} required /></Field>
          {kind === 'purchase' && <>
            <Field title={t('الصنف', 'Product')}><select name="product" required defaultValue=""><option value="" disabled>{t('اختر صنفًا', 'Select product')}</option>{data.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field title={t('الكمية', 'Quantity')}><input name="quantity" type="number" min="1" max="100000000" step="1" inputMode="numeric" required /></Field>
            {!data.products.length && <p className="form-note field-wide">{t('أضف صنفًا من صفحة المخزون أولًا.', 'Add a product in Inventory first.')}</p>}
          </>}
          {!debt && kind !== 'purchase' && <Field title={t('التصنيف', 'Category')}><input name="category" maxLength={80} list="categories" placeholder={t('مثال: إيجار سيارة', 'e.g. Vehicle rental')} required />
            <datalist id="categories">{[t('إيجار سيارة', 'Vehicle rental'), t('وقود', 'Fuel'), t('سكن ومكتب', 'Accommodation and office'), t('إكراميات', 'Tips'), t('أكل وشرب', 'Food and drink'), t('تمويل مؤقت', 'Temporary funding'), t('نقل وشحن', 'Freight'), t('معدات', 'Equipment'), ...new Set(data.entries.map(e => e.category))].map((value, index) => <option key={index} value={value} />)}</datalist>
          </Field>}
          <Field title={t('العملة', 'Currency')}><select value={currency} onChange={e => setCurrency(e.target.value as Currency)} disabled={Boolean(debt)}>{currencies.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field title={t('المبلغ الإجمالي', 'Total amount')}><input type="number" inputMode="decimal" min="0.01" max={debt ? debtBalance(debt, data.entries) / 100 : 1000000000} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required /></Field>
          {kind === 'purchase' && <Field title={t('المبلغ المدفوع', 'Amount paid')}><input name="paid" type="number" inputMode="decimal" min="0" max={amount || undefined} step="0.01" required /></Field>}
          {currency !== 'SAR' && <Field title={t('ريال لكل وحدة من العملة', 'SAR per unit of currency')}><input type="number" inputMode="decimal" min="0.000001" max="10000" step="0.000001" value={rate} onChange={e => setRate(e.target.value)} placeholder={debt ? String(debt.rate) : undefined} required /></Field>}
          <Field title={t('طريقة الدفع', 'Payment method')}><select name="method"><option value="bank">{t('تحويل بنكي', 'Bank transfer')}</option><option value="cash">{t('نقدًا', 'Cash')}</option><option value="card">{t('بطاقة', 'Card')}</option></select></Field>
          {kind === 'expense' && scope === 'business' && data.containers.length > 0 && <Field title={t('ربط بحاوية (اختياري)', 'Link to container (optional)')}><select name="container" defaultValue={entry?.container?.id ?? ''}><option value="">{t('بدون حاوية', 'No container')}</option>{data.containers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          {currency !== 'SAR' && Number(amount) > 0 && Number(amount) <= 1000000000 && Number(rate) > 0 && Number(rate) <= 10000 && <p className="form-note field-wide">{t('ما يعادله بالريال', 'SAR equivalent')}: <bdi>{money(toSar(minor(amount), Number(rate)), 'SAR', lang)}</bdi></p>}
          {!demo && <Field title={t('فاتورة أو إيصال (اختياري)', 'Invoice or receipt (optional)')} wide><div className="file-field"><Paperclip size={16} /><input name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></div></Field>}
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
      </div>
      {error && <p className="error-box" role="alert">{error}</p>}
      <footer className="dialog-actions">
        <button className="btn secondary" type="button" onClick={close} disabled={busy}>{t('إلغاء', 'Cancel')}</button>
        <button className="btn primary" type="submit" disabled={busy}><Check size={17} />{busy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ', 'Save')}</button>
      </footer>
    </form>
  </dialog>;
}
