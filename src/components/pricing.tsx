'use client';

import { useEffect, useState, type FormEvent, type SetStateAction } from 'react';
import { Calculator, FileSpreadsheet, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { baseAmount, money as formatMoney, type Dataset, type Lang } from '@/lib/domain';
import { calculatePricing, copyContainerForPricing, copyExpenseForPricing, copyInvoiceForPricing, emptyPricing, pricingInvoiceIds, pricingLimit, pricingSheetSchema, recoverPricingExpenseSources, recoverPricingInvoiceSources, toPounds, type PricingDocument, type PricingExpense, type PricingItem, type PricingSheet } from '@/lib/pricing';
import { loadPricingSheets, savePricingSheet } from '@/lib/pricing-storage';
import { loadData } from '@/lib/storage';
import { errorMessage, Field, translate } from './forms';
import { PricingDialog, PricingMoney, PricingRowEditor, QuickPricing } from './pricing-forms';

type Editor = {type: 'item'; row?: PricingItem} | {type: 'expense'; row?: PricingExpense};
const withRow = <T extends {id: string}>(rows: T[], row: T) => rows.some(existing => existing.id === row.id)
  ? rows.map(existing => existing.id === row.id ? row : existing) : [...rows, row];

export function Pricing({ data, lang }: { data: Dataset; lang: Lang }) {
  const t = translate(lang);
  const [sheets, setSheets] = useState<PricingSheet[] | null>(null);
  const [draft, setDraft] = useState<PricingSheet | null>(null);
  const [expected, setExpected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<'new' | 'invoice' | 'expense' | 'quick' | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [source, setSource] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [copying, setCopying] = useState(false);
  const [view, setView] = useState<'items' | 'expenses'>('items');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    loadPricingSheets().then(result => {if (active) setSheets(result);})
      .catch(problem => {if (active) setError(errorMessage(problem));});
    return () => {active = false;};
  }, [revision]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = true;};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const maySwitch = () => !dirty || window.confirm(t('عندك تعديلات غير محفوظة. تبي تترك الكشف؟', 'Leave this sheet and discard unsaved changes?'));
  function choose(sheet: PricingSheet | null, saved: boolean) {
    setDraft(sheet && saved ? {...sheet, document: {...recoverPricingInvoiceSources(data, sheet), expenses: recoverPricingExpenseSources(data, sheet)}} : sheet);
    setExpected(saved ? sheet?.version ?? null : null);
    setDirty(Boolean(sheet && !saved));
    setView('items');
    setError('');
    setMessage('');
  }
  function update(action: SetStateAction<PricingDocument>) {
    setDraft(old => old && ({...old, document: typeof action === 'function' ? action(old.document) : action}));
    setDirty(true);
    setMessage('');
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
    if (!name || copying) return;
    setCopying(true);
    setSourceError('');
    try {
      let document = emptyPricing();
      if (source) {
        const current = await loadData();
        const container = current.containers.find(row => row.id === source);
        if (!container) throw new Error(t('الحاوية غير موجودة.', 'Container not found.'));
        document = copyContainerForPricing(current, container);
      }
      if (document.items.length > pricingLimit || document.expenses.length > pricingLimit) {
        throw new Error(t('الحد 500 منتج أو مصروف لكل كشف.', 'Each sheet supports up to 500 products and 500 expenses.'));
      }
      choose({ id: crypto.randomUUID(), version: crypto.randomUUID(), name, document, updated_at: new Date().toISOString() }, false);
      setDialog(null);
    } catch (problem) {setSourceError(errorMessage(problem));}
    finally {setCopying(false);}
  }
  async function addFromInvoice(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft || !source || copying) return;
    setCopying(true);
    setSourceError('');
    try {
      const current = await loadData();
      const invoice = current.entries.find(row => row.id === source && row.kind === 'purchase' && !row.voided_at && row.invoice_items?.length);
      if (!invoice) throw new Error(t('الفاتورة غير موجودة.', 'Invoice not found.'));
      const document = recoverPricingInvoiceSources(current, draft);
      if (pricingInvoiceIds(document.items).has(invoice.id)) throw new Error(t('هذه الفاتورة مضافة للكشف بالفعل.', 'This invoice is already in the sheet.'));
      const items = copyInvoiceForPricing(invoice, document.items);
      if (!items.length) throw new Error(t('بنود هذه الفاتورة مضافة للكشف بالفعل.', 'This invoice has already been copied to the sheet.'));
      if (document.items.length + items.length > pricingLimit) throw new Error(t('الحد 500 منتج لكل كشف.', 'Each sheet supports up to 500 products.'));
      update({...document, items: [...document.items, ...items]});
      setMessage(t(`أُضيف ${items.length} بندًا. احفظ الكشف لتثبيت الإضافة.`, `${items.length} items added. Save the sheet to keep them.`));
      setDialog(null);
    } catch (problem) {setSourceError(errorMessage(problem));}
    finally {setCopying(false);}
  }
  async function addFromExpense(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft || !source || copying) return;
    setCopying(true);
    setSourceError('');
    try {
      const current = await loadData();
      const entry = current.entries.find(row => row.id === source && row.kind === 'expense' && !row.voided_at);
      if (!entry) throw new Error(t('المصروف غير موجود.', 'Expense not found.'));
      const expenses = recoverPricingExpenseSources(current, draft);
      if (expenses.some(row => row.entryId === entry.id)) throw new Error(t('المصروف مضاف للكشف بالفعل.', 'This expense is already in the sheet.'));
      if (expenses.length >= pricingLimit) throw new Error(t('الحد 500 مصروف لكل كشف.', 'Each sheet supports up to 500 expenses.'));
      update(old => ({...old, expenses: [...expenses, copyExpenseForPricing(entry)]}));
      setMessage(t('أُضيف المصروف. احفظ الكشف لتثبيت الإضافة.', 'Expense added. Save the sheet to keep it.'));
      setDialog(null);
    } catch (problem) {setSourceError(errorMessage(problem));}
    finally {setCopying(false);}
  }
  function validate() {
    const parsed = pricingSheetSchema.safeParse(draft);
    if (parsed.success) return parsed.data;
    setError(t('راجع اسم الكشف والكميات والمبالغ قبل المتابعة.', 'Check the sheet name, quantities and amounts before continuing.'));
    return null;
  }
  async function save() {
    setError('');
    const record = validate();
    if (!record || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const next = await savePricingSheet(record, expected);
      if (!next) {
        setRevision(n => n + 1);
        setError(t('تعدّل الكشف في جلسة ثانية. تقدر تصدّر نسختك ثم تعيد فتح الكشف.', 'This sheet changed in another session. Export your copy, then reopen the sheet.'));
        return;
      }
      setDraft(next);
      setExpected(next.version);
      setDirty(false);
      setSheets(old => [next, ...(old ?? []).filter(sheet => sheet.id !== next.id)]);
      setMessage(t('تم حفظ كشف التسعير.', 'Pricing sheet saved.'));
    } catch (problem) {setError(errorMessage(problem));}
    finally {setBusy(false);}
  }
  async function download() {
    setError('');
    const record = validate();
    if (!record || exporting) return;
    setExporting(true);
    try {await (await import('@/lib/pricing-excel')).downloadPricingExcel(record);}
    catch (problem) {setError(errorMessage(problem));}
    finally {setExporting(false);}
  }

  const stats = draft && calculatePricing(draft.document);
  const money = (amount: number | null) => <PricingMoney value={amount} lang={lang} />;
  const pct = (amount: number) => new Intl.NumberFormat(lang === 'ar' ? 'ar-SA' : 'en-GB', { style: 'percent', maximumFractionDigits: 1 }).format(amount);
  const itemHead = [t('المنتج', 'Product'), t('شراء الوحدة', 'Purchase per unit'), t('التكلفة بعد المصاريف', 'Landed per sale unit'), t('سعر البيع (£)', 'Sale price (£)'), t('ربح الوحدة', 'Profit per unit'), t('خيارات', 'Actions')];
  const stageLabel = (stage: PricingExpense['stage']) => ({UK: t('بريطانيا', 'UK'), Shipping: t('الشحن', 'Shipping'), Jeddah: t('جدة', 'Jeddah'), '': ''}[stage]);
  const addedInvoices = draft && dialog === 'invoice' ? pricingInvoiceIds(recoverPricingInvoiceSources(data, draft).items) : new Set<string>();
  const invoices = dialog === 'invoice' ? data.entries.filter(entry => entry.kind === 'purchase' && !entry.voided_at && entry.invoice_items?.length && !addedInvoices.has(entry.id))
    .sort((a, b) => b.date.localeCompare(a.date)) : [];
  const addedExpenses = draft && dialog === 'expense' ? new Set(recoverPricingExpenseSources(data, draft).map(row => row.entryId)) : new Set<string>();
  const expenses = dialog === 'expense' ? data.entries.filter(entry => entry.kind === 'expense' && !entry.voided_at && !addedExpenses.has(entry.id))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)) : [];
  const selectedExpense = expenses.find(entry => entry.id === source);
  const openSource = (type: 'new' | 'invoice' | 'expense') => {
    setSource('');
    setSourceError('');
    setError('');
    setDialog(type);
  };
  return <div className="pricing-page">
    <div className="actions pricing-toolbar">
      <button className="btn primary" disabled={busy || sheets === null} onClick={() => {if (maySwitch()) openSource('new');}}><Plus size={17} />{t('كشف جديد', 'New sheet')}</button>
      <button className="btn secondary" onClick={() => setDialog('quick')}><Calculator size={17} />{t('حسبة سريعة', 'Quick calculator')}</button>
      {draft && <button className="btn secondary" disabled={exporting || busy} onClick={download}><FileSpreadsheet size={17} />{exporting ? t('جارٍ التصدير…', 'Exporting…') : t('تصدير Excel', 'Export Excel')}</button>}
    </div>
    {error && <div className="error-box" role="alert">{error} {sheets === null && <button className="btn secondary" onClick={() => {setError(''); setRevision(n => n + 1);}}>{t('إعادة المحاولة', 'Retry')}</button>}</div>}
    {message && <p className="form-note" role="status">{message}</p>}
    {sheets === null && !error && <p className="panel empty" role="status">{t('جارٍ تحميل الكشوف…', 'Loading pricing sheets…')}</p>}
    {sheets && <div className="panel pricing-settings">
      <Field title={t('الكشوف المحفوظة', 'Saved sheets')}><select disabled={busy} value={expected ? draft?.id ?? '' : ''} onChange={event => {
        const sheet = sheets.find(row => row.id === event.target.value);
        if (maySwitch()) choose(sheet ?? null, Boolean(sheet));
      }}><option value="">{t('اختر كشفًا', 'Choose a sheet')}</option>{sheets.map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}</select></Field>
      {draft && <>
        <Field title={t('اسم الكشف', 'Sheet name')}><input value={draft.name} disabled={busy} maxLength={160} onChange={event => {
          const name = event.target.value;
          setDraft(old => old && ({...old, name})); setDirty(true); setMessage('');
        }} /></Field>
        <Field title={t('توزيع المصاريف', 'Allocate expenses by')}><select value={draft.document.allocation} disabled={busy} onChange={event => {
          const allocation = event.target.value === 'value' ? 'value' : 'quantity'; update(old => ({...old, allocation}));
        }}><option value="quantity">{t('حسب الكمية', 'Quantity')}</option><option value="value">{t('حسب قيمة الشراء', 'Purchase value')}</option></select></Field>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}><Save size={17} />{busy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ الكشف', 'Save sheet')}</button>
      </>}
    </div>}
    {sheets && !draft && <div className="panel empty">{t('أنشئ كشفًا من حاوية أو ابدأ كشفًا فارغًا.', 'Create a sheet from a container or start blank.')}</div>}
    {draft && stats && <>
      <div className="metric-grid pricing-metrics" aria-live="polite">
        <div className="metric pricing-metric pricing-total"><span>{t('إجمالي التكلفة', 'Total cost')}</span>{money(stats.cost)}</div>
        <div className="metric pricing-metric"><span>{t('المبيعات المتوقعة', 'Expected sales')}</span>{money(stats.priced ? stats.revenue : null)}<small>{t(`${stats.priced} من ${draft.document.items.length} مسعّر`, `${stats.priced} of ${draft.document.items.length} priced`)}</small></div>
        <div className="metric pricing-metric"><span>{t('الربح المتوقع', 'Expected profit')}</span>{money(stats.priced && !stats.unallocated ? stats.profit : null)}{stats.margin !== null && !stats.unallocated && <small>{t('الهامش', 'Margin')} {pct(stats.margin)}</small>}</div>
      </div>
      {stats.unallocated > 0 && <p className="form-note">{t('بعض المصاريف لم تتوزع. راجع الكميات أو طريقة التوزيع.', 'Some expenses are unallocated. Check the quantities or allocation method.')}</p>}
      <div className="actions purchase-switch" role="group" aria-label={t('محتويات كشف التسعير', 'Pricing sheet contents')}>
        <button className="btn secondary" aria-pressed={view === 'items'} onClick={() => setView('items')}>{t('المنتجات', 'Products')}</button>
        <button className="btn secondary" aria-pressed={view === 'expenses'} onClick={() => setView('expenses')}>{t('المصاريف', 'Expenses')}</button>
      </div>
      <section className="panel pricing-table-panel">
        <div className="pricing-section-heading"><h2>{view === 'items' ? t('تسعير المنتجات', 'Product pricing') : t('مصاريف الكشف', 'Sheet expenses')}</h2>
          <div className="actions">
            {view === 'items' && <button className="btn secondary" disabled={busy || draft.document.items.length >= pricingLimit} onClick={() => openSource('invoice')}>{t('إضافة من فاتورة', 'Add from invoice')}</button>}
            {view === 'expenses' && <button className="btn secondary" disabled={busy || draft.document.expenses.length >= pricingLimit} onClick={() => openSource('expense')}>{t('إضافة من مصروف مسجّل', 'Add a recorded expense')}</button>}
            <button className="btn secondary" disabled={busy || draft.document[view].length >= pricingLimit} onClick={() => setEditor({type: view === 'items' ? 'item' : 'expense'})}><Plus size={16} />{view === 'items' ? t('إضافة منتج', 'Add product') : t('إضافة مصروف', 'Add expense')}</button>
          </div>
        </div>
        {view === 'items' && (draft.document.items.length === 0 ? <p className="empty">{t('لا توجد منتجات في الكشف.', 'No products in this sheet.')}</p> :
          <div className="table-scroll"><table className="pricing-table" aria-label={t('تسعير المنتجات', 'Product pricing')}>
            <thead><tr>{itemHead.map(title => <th key={title} scope="col">{title}</th>)}</tr></thead>
            <tbody>{draft.document.items.map((item, i) => {
              const row = stats.rows[i], label = item.english || item.name;
              return <tr key={item.id}>
                <td data-label={itemHead[0]}><strong dir="auto">{label}</strong>{item.english && item.name && item.english !== item.name && <small className="table-sub" dir="auto">{item.name}</small>}
                  <small className="table-sub">{item.quantity} {item.unit}{item.pack > 1 && ` × ${item.pack}`}</small></td>
                <td data-label={itemHead[1]}>{money(item.purchase)}</td>
                <td data-label={itemHead[2]}>{money(row.landed)}</td>
                <td data-label={itemHead[3]}><label className="field pricing-sale"><input type="number" min="0" max="1000000000000" step="0.01" inputMode="decimal" dir="ltr" disabled={busy}
                  aria-label={t(`سعر بيع ${label} بالباوند`, `${label} sale price in pounds`)} value={item.sale ?? ''} placeholder="—" onChange={event => {
                    const sale = event.target.value === '' ? null : event.target.valueAsNumber;
                    if (sale !== null && (!Number.isFinite(sale) || sale < 0 || sale > 1_000_000_000_000)) return;
                    update(old => ({...old, items: withRow(old.items, {...item, sale})}));
                  }} /></label></td>
                <td data-label={itemHead[4]} className={row.profit !== null && row.profit < 0 ? 'pricing-loss' : ''}>{money(stats.unallocated ? null : row.profit)}{row.margin !== null && !stats.unallocated && <small className="table-sub">{pct(row.margin)}</small>}</td>
                <td data-label={itemHead[5]}><RowActions lang={lang} label={label} busy={busy} edit={() => setEditor({type: 'item', row: item})} remove={() => update(old => ({...old, items: old.items.filter(product => product.id !== item.id)}))} /></td>
              </tr>;
            })}</tbody>
          </table></div>)}
        {view === 'expenses' && <div className="pricing-expense-list">
          {draft.document.expenses.length === 0 && <p className="empty">{t('لا توجد مصاريف في الكشف.', 'No expenses in this sheet.')}</p>}
          {draft.document.expenses.map(row => <div className="pricing-expense" key={row.id}><div><strong dir="auto">{row.label}</strong>{row.stage && <small className="table-sub">{stageLabel(row.stage)}</small>}</div>
            {money(toPounds(row.amount, row.currency))}<RowActions lang={lang} label={row.label} busy={busy} edit={() => setEditor({type: 'expense', row})} remove={() => update(old => ({...old, expenses: old.expenses.filter(expense => expense.id !== row.id)}))} /></div>)}
        </div>}
      </section>
    </>}
    {dialog === 'new' && <PricingDialog title={t('كشف تسعير جديد', 'New pricing sheet')} lang={lang} close={() => {if (!copying) setDialog(null);}}>
      <form className="dialog-body" onSubmit={create}><div className="form-grid">
        <Field wide title={t('نسخ بيانات من حاوية (اختياري)', 'Copy from a container (optional)')}><select disabled={copying} value={source} onChange={event => setSource(event.target.value)}>
          <option value="">{t('بدء كشف فارغ', 'Start blank')}</option>{data.containers.map(container => <option key={container.id} value={container.id}>{container.name}</option>)}</select></Field>
        <Field wide title={t('اسم الكشف', 'Sheet name')}><input disabled={copying} key={source} name="name" required maxLength={160} pattern=".*\S.*" defaultValue={data.containers.find(container => container.id === source)?.name} /></Field>
      </div>{sourceError && <p className="error-box" role="alert">{sourceError}</p>}
      <footer className="dialog-actions"><button className="btn primary" disabled={copying}>{copying ? t('جارٍ نسخ الحمولة…', 'Copying manifest…') : t('إنشاء الكشف', 'Create sheet')}</button></footer></form>
    </PricingDialog>}
    {dialog === 'invoice' && <PricingDialog title={t('إضافة من فاتورة مشتريات', 'Add from a purchase invoice')} lang={lang} close={() => {if (!copying) setDialog(null);}}>
      <form className="dialog-body" onSubmit={addFromInvoice}>
        <Field title={t('فاتورة المشتريات', 'Purchase invoice')}><select aria-label={t('فاتورة المشتريات', 'Purchase invoice')} required disabled={copying || !invoices.length} value={source} onChange={event => setSource(event.target.value)}>
          <option value="">{invoices.length ? t('اختر فاتورة', 'Choose an invoice') : t('لا توجد فواتير غير مضافة', 'No remaining invoices to add')}</option>
          {invoices.map(invoice => <option key={invoice.id} value={invoice.id}>{invoice.invoice_number} · {invoice.party} · {invoice.date}</option>)}
        </select></Field>
        {sourceError && <p className="error-box" role="alert">{sourceError}</p>}
        <footer className="dialog-actions"><button className="btn primary" disabled={copying || !source}>{copying ? t('جارٍ النسخ…', 'Copying…') : t('إضافة بنود الفاتورة', 'Add invoice items')}</button></footer>
      </form>
    </PricingDialog>}
    {dialog === 'expense' && <PricingDialog title={t('إضافة من مصروف مسجّل', 'Add a recorded expense')} lang={lang} close={() => {if (!copying) setDialog(null);}}>
      <form className="dialog-body" onSubmit={addFromExpense}>
        <Field title={t('المصروف المسجّل', 'Recorded expense')}><select aria-label={t('المصروف المسجّل', 'Recorded expense')} required disabled={copying || !expenses.length} value={source} onChange={event => setSource(event.target.value)}>
          <option value="">{expenses.length ? t('اختر مصروفًا', 'Choose an expense') : t('لا توجد مصاريف مسجّلة غير مضافة', 'No remaining recorded expenses to add')}</option>
          {expenses.map(entry => <option key={entry.id} value={entry.id}>{entry.description} · {formatMoney(entry.amount, entry.currency, lang)} · {entry.date}</option>)}
        </select></Field>
        {selectedExpense && selectedExpense.currency !== 'GBP' && selectedExpense.currency !== 'SAR' && <p className="table-sub">
          {t('يُنسخ بما يعادله بالريال', 'Copied at the recorded SAR equivalent')} <bdi>{formatMoney(baseAmount(selectedExpense), 'SAR', lang)}</bdi>
        </p>}
        {sourceError && <p className="error-box" role="alert">{sourceError}</p>}
        <footer className="dialog-actions"><button className="btn primary" disabled={copying || !source}>{copying ? t('جارٍ النسخ…', 'Copying…') : t('إضافة المصروف', 'Add expense')}</button></footer>
      </form>
    </PricingDialog>}
    {dialog === 'quick' && <QuickPricing lang={lang} close={() => setDialog(null)} />}
    {editor && <PricingRowEditor editor={editor} lang={lang} close={() => setEditor(null)}
      applyItem={row => update(old => ({...old, items: withRow(old.items, row)}))}
      applyExpense={row => update(old => ({...old, expenses: withRow(old.expenses, row)}))} />}
  </div>;
}

function RowActions({ lang, label, busy, edit, remove }: {lang: Lang; label: string; busy: boolean; edit: () => void; remove: () => void}) {
  const t = translate(lang);
  return <div className="actions pricing-row-actions">
    <button className="icon-btn" aria-label={t(`تعديل ${label}`, `Edit ${label}`)} onClick={edit} disabled={busy}><Pencil size={15} /></button>
    <button className="icon-btn debt-delete" aria-label={t(`حذف ${label} من الكشف`, `Remove ${label} from sheet`)} onClick={remove} disabled={busy}><Trash2 size={15} /></button>
  </div>;
}
