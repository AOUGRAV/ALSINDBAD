'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeftRight, Check, Download, Pencil, Trash2, Wallet, X } from 'lucide-react';
import { currencies, kindLabels, minor, today, validateEntry, type CashTransfer, type Dataset, type Entry, type Lang } from '@/lib/domain';
import { cashAccount, custodyLedger, custodyPeriod } from '@/lib/custody';
import { custodyReport } from '@/lib/detail-reports';
import { Empty } from './views';
import { Field, errorMessage, translate, type Editor, type RecordChange } from './forms';
import { MoneyAmount, PoundEquivalent } from './money-amount';

export function Custody({ data, lang, edit, onReceipt }: {
  data: Dataset; lang: Lang; edit: (editor: Editor) => void; onReceipt: (path: string) => void;
}) {
  const t = translate(lang);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState<'all' | 'funding' | 'outgoing' | 'transfer' | 'excluded'>('all');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const ledger = custodyLedger(data.entries, data.cash_transfers);
  const period = custodyPeriod(ledger, from, to);
  const rows = [...period.rows].reverse().filter(row => filter === 'all' || (filter === 'transfer' ? row.transfer :
    filter === 'funding' ? row.entry?.kind === 'funding' : row.amount < 0));
  const validDates = !from || !to || from <= to;
  async function exportExcel() {
    if (exporting || !validDates) return;
    setExporting(true);
    setExportError('');
    try {
      const { downloadReportExcel } = await import('@/lib/download-report');
      await downloadReportExcel(custodyReport(data, from, to, lang));
    } catch (problem) { setExportError(errorMessage(problem)); }
    finally { setExporting(false); }
  }
  const excludedEntries = data.entries.filter(entry => entry.custody_excluded && !entry.voided_at &&
    (!from || entry.date >= from) && (!to || entry.date <= to)).sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const metrics = [
    { label: t('إجمالي المستلم', 'Total received'), amount: period.incoming },
    { label: t('إجمالي المصروف', 'Total paid'), amount: period.outgoing },
    { label: to ? t('المتبقي حتى نهاية الفترة', 'Balance at period end') : t('المتبقي معك', 'Remaining funds'), amount: period.remaining },
  ];
  return <>
    <div className="actions custody-actions">
      <button className="btn secondary" onClick={() => edit({ type: 'transfer' })}><ArrowLeftRight size={17} />{t('تحويل بين الكاش والبنك', 'Transfer between cash and bank')}</button>
      <button className="btn secondary" disabled={exporting || !validDates} onClick={exportExcel}><Download size={17} />{exporting ? t('جارٍ التصدير…', 'Exporting…') : t('تصدير Excel', 'Export Excel')}</button>
    </div>
    {exportError && <p className="error-box" role="alert">{exportError}</p>}
    <section className="panel">
      <div className="filters custody-filters">
        <Field title={t('من تاريخ', 'From date')}><input type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} /></Field>
        <Field title={t('إلى تاريخ', 'To date')}><input type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></Field>
        {(from || to) && <button className="btn secondary" onClick={() => { setFrom(''); setTo(''); }}>{t('كل الفترات', 'All dates')}</button>}
      </div>
    </section>
    {!validDates ? <p className="error-box" role="alert">{t('تحقق من ترتيب التاريخين.', 'Check the date range.')}</p> : <>
      {from && <p className="custody-opening">{t('رصيد بداية الفترة', 'Opening balance')} <MoneyAmount amount={period.opening} lang={lang} /></p>}
      <div className="metric-grid custody-metrics">{metrics.map((metric, index) => <article className={'metric' + (index === 2 ? ' metric-feature' : '')} key={metric.label}>
        <div className="metric-top"><span>{metric.label}</span><Wallet size={18} /></div>
        <div className="metric-value"><MoneyAmount amount={metric.amount} lang={lang} /></div>
      </article>)}</div>
      <section className="panel custody-balances">
        <div><span>{t('الكاش', 'Cash')}</span><strong><MoneyAmount amount={period.cash} lang={lang} /></strong></div>
        <div><span>{t('البنك والبطاقة', 'Bank and card')}</span><strong><MoneyAmount amount={period.bank} lang={lang} /></strong></div>
      </section>
      <section className="panel">
        <div className="filters">
          <Field title={t('الحركات', 'Movements')}><select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
            <option value="all">{t('كل الحركات', 'All movements')}</option>
            <option value="funding">{t('المستلم من المالك', 'Received from owner')}</option>
            <option value="outgoing">{t('المدفوعات', 'Payments')}</option>
            <option value="transfer">{t('التحويلات الداخلية', 'Internal transfers')}</option>
            <option value="excluded">{t('المستبعد من العهدة', 'Excluded from custody')}</option>
          </select></Field>
        </div>
        {filter === 'excluded' ? <>
          {!excludedEntries.length && <Empty>{t('لا توجد حركات مستبعدة.', 'No excluded movements.')}</Empty>}
          {excludedEntries.map(entry => <article className="custody-row custody-transfer" key={entry.id}>
            <div><strong>{entry.invoice_number ? t('فاتورة ', 'Invoice ') + entry.invoice_number : entry.description}</strong>
              <small>{entry.party} · <bdi>{entry.date}</bdi> · {t(...kindLabels[entry.kind])}</small>
              {entry.notes && <p className="record-note">{entry.notes}</p>}
            </div>
            <MoneyAmount amount={entry.paid} currency={entry.currency} lang={lang} />
            <button className="btn secondary" onClick={() => edit({ type: 'custody-exclusion', original: entry, excluded: false })}>{t('إعادة للعهدة', 'Include in custody')}</button>
          </article>)}
        </> : <>
        {!rows.length && <Empty>{t('لا توجد حركات في هذه الفترة.', 'No movements in this period.')}</Empty>}
        <div className="custody-list">{rows.map(row => <article key={row.id} className="custody-row">
          {row.entry ? <div className="custody-transfer">
            <div><strong>{row.entry.invoice_number ? t('فاتورة ', 'Invoice ') + row.entry.invoice_number : row.entry.description}</strong>
              <small><bdi>{row.date}</bdi> · {row.entry.party} · {t(...kindLabels[row.entry.kind])} · {cashAccount(row.entry.method) === 'cash' ? t('كاش', 'Cash') : t('البنك والبطاقة', 'Bank and card')}</small>
              {row.entry.notes && <p className="record-note">{row.entry.notes}</p>}
            </div>
            <MoneyAmount amount={row.entry.paid} currency={row.entry.currency} lang={lang} />
            <div className="actions">
              <button className="btn secondary" onClick={() => edit({ type: row.entry.invoice_items ? 'purchase' : 'entry', original: row.entry })}><Pencil size={16} />{t('تعديل', 'Edit')}</button>
              {row.entry.receipt_path && <button className="icon-btn" aria-label={t('تنزيل المرفق', 'Download attachment')} onClick={() => onReceipt(row.entry.receipt_path!)}><Download size={16} /></button>}
              {row.entry.kind === 'purchase'
                ? <button className="btn secondary" onClick={() => edit({ type: 'invoice-payment', original: row.entry })}>{t('تصحيح خصم العهدة', 'Correct custody deduction')}</button>
                : <button className="btn secondary" onClick={() => edit({ type: 'custody-exclusion', original: row.entry, excluded: true })}>{t('استبعاد من العهدة', 'Exclude from custody')}</button>}
            </div>
          </div> :
            <div className="custody-transfer">
              <div><strong>{row.transfer.from_account === 'cash' ? t('من الكاش إلى البنك', 'Cash to bank') : t('من البنك إلى الكاش', 'Bank to cash')}</strong>
                <small><bdi>{row.date}</bdi></small>
                {row.transfer.notes && <p className="record-note">{row.transfer.notes}</p>}
              </div>
              <MoneyAmount amount={row.transfer.amount} currency={row.transfer.currency} lang={lang} />
              <button className="btn secondary" onClick={() => edit({ type: 'transfer', original: row.transfer })}><Pencil size={16} />{t('تعديل', 'Edit')}</button>
            </div>}
          <div className="custody-row-balance">
            <span>{row.entry ? (row.amount > 0 ? t('المستلم', 'Received') : t('المدفوع', 'Paid')) : t('التحويل', 'Transfer')}</span>
            <MoneyAmount amount={Math.abs(row.amount || row.cash)} lang={lang} />
            <span>{t('المتبقي بعد الحركة', 'Balance after movement')}</span><strong><MoneyAmount amount={row.balance} lang={lang} /></strong>
          </div>
        </article>)}</div></>}
      </section>
    </>}
  </>;
}

export function CustodyExclusionEditor({ original, excluded, lang, close, save }: {
  original: Entry; excluded: boolean; lang: Lang; close: () => void; save: (change: RecordChange) => Promise<void>;
}) {
  const t = translate(lang);
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = excluded ? t('استبعاد من العهدة', 'Exclude from custody') : t('إعادة للعهدة', 'Include in custody');
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await save({ type: 'custody-exclusion', original, excluded });
      close();
    } catch (problem) {
      setError(errorMessage(problem));
      setBusy(false);
    }
  }
  return <dialog ref={dialog} className="editor" aria-labelledby="custody-exclusion-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header className="dialog-head"><h2 id="custody-exclusion-title">{title}</h2>
      <button className="icon-btn" type="button" onClick={close} disabled={busy} aria-label={t('إغلاق', 'Close')}><X size={19} /></button></header>
    <form onSubmit={submit}>
      <p>{original.party} · {original.description}</p>
      <p><MoneyAmount amount={original.paid} currency={original.currency} lang={lang} /></p>
      {error && <p className="error-box" role="alert">{error}</p>}
      <footer className="dialog-actions"><button type="button" className="btn secondary" disabled={busy} onClick={close}>{t('رجوع', 'Back')}</button>
        <button className="btn primary" disabled={busy}><Check size={16} />{busy ? t('جارٍ الحفظ…', 'Saving…') : title}</button></footer>
    </form>
  </dialog>;
}

export function InvoicePaymentEditor({ original, data, lang, close, save }: {
  original: Entry; data: Dataset; lang: Lang; close: () => void; save: (change: RecordChange) => Promise<void>;
}) {
  const t = translate(lang);
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (source !== 'external' && source !== 'unpaid')) return;
    setBusy(true);
    setError('');
    try {
      const value = validateEntry({ ...original, paid: source === 'unpaid' ? 0 : original.paid,
        paid_outside_custody: source === 'external' }, data, original);
      await save({ type: 'entry', value, original, reason: source === 'external'
        ? t('تصحيح السداد إلى خارج العهدة', 'Corrected payment to outside custody')
        : t('تصحيح الفاتورة إلى غير مسددة', 'Corrected invoice to unpaid') });
      close();
    } catch (problem) {
      setError(errorMessage(problem));
      setBusy(false);
    }
  }
  return <dialog ref={dialog} className="editor" aria-labelledby="invoice-payment-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header className="dialog-head"><h2 id="invoice-payment-title">{t('تصحيح خصم العهدة', 'Correct custody deduction')}</h2>
      <button className="icon-btn" type="button" onClick={close} disabled={busy} aria-label={t('إغلاق', 'Close')}><X size={19} /></button></header>
    <form onSubmit={submit}>
      <fieldset className="purchase-fields" disabled={busy}>
        <p>{original.party} · <bdi>{original.invoice_number}</bdi></p>
        <p>{t('الدفعة المسجلة', 'Recorded payment')} <MoneyAmount amount={original.paid} currency={original.currency} lang={lang} /></p>
        <Field title={t('حالة المبلغ', 'Payment treatment')} wide><select aria-label={t('حالة المبلغ', 'Payment treatment')} value={source} onChange={event => setSource(event.target.value)} required>
          <option value="" disabled>{t('اختر حالة السداد', 'Select payment treatment')}</option>
          <option value="external">{t('دُفع من خارج العهدة', 'Paid outside custody')}</option>
          <option value="unpaid">{t('لم أسدد المبلغ المسجل', 'Recorded payment was not made')}</option>
        </select></Field>
      </fieldset>
      {error && <p className="error-box" role="alert">{error}</p>}
      <footer className="dialog-actions"><button className="btn secondary" type="button" onClick={close} disabled={busy}>{t('رجوع', 'Back')}</button>
        <button className="btn primary" disabled={busy || !source}><Check size={16} />{busy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ التصحيح', 'Save correction')}</button></footer>
    </form>
  </dialog>;
}

export function CashTransferEditor({ original, lang, close, save }: {
  original?: CashTransfer; lang: Lang; close: () => void; save: (change: RecordChange) => Promise<void>;
}) {
  const t = translate(lang);
  const dialog = useRef<HTMLDialogElement>(null);
  const identity = useRef(original?.id ?? crypto.randomUUID());
  const [currency, setCurrency] = useState(original?.currency ?? 'SAR');
  const [amount, setAmount] = useState(original ? (original.amount / 100).toFixed(2) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const value = (name: string) => String(fields.get(name) ?? '').trim();
    const rate = currency === 'SAR' ? 1 : Number(value('rate'));
    const principal = minor(amount);
    if (!Number.isSafeInteger(principal) || principal <= 0 || principal > 100_000_000_000 ||
      !Number.isFinite(rate) || rate <= 0 || rate > 10_000 || Math.round(rate * 1_000_000) / 1_000_000 !== rate) {
      setError(t('تحقق من المبلغ وسعر الصرف.', 'Check the amount and exchange rate.'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await save({ type: 'transfer', expected: original?.revision ?? 0, remove: removing, value: {
        id: identity.current, date: value('date'), amount: principal, currency, rate,
        from_account: value('from_account') as CashTransfer['from_account'], notes: value('notes'),
        created_at: original?.created_at ?? new Date().toISOString(), revision: original?.revision ?? 1, voided_at: null,
      } });
      close();
    } catch (problem) {
      setError(errorMessage(problem));
      setBusy(false);
    }
  }
  return <dialog className="editor" ref={dialog} aria-labelledby="cash-transfer-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header className="dialog-head"><h2 id="cash-transfer-title">{t('تحويل بين الكاش والبنك', 'Transfer between cash and bank')}</h2>
      <button className="icon-btn" type="button" onClick={close} disabled={busy} aria-label={t('إغلاق', 'Close')}><X size={19} /></button></header>
    <form onSubmit={submit}>
      <fieldset className="purchase-fields" disabled={busy}>
        <div className="form-grid">
          <Field title={t('الاتجاه', 'Direction')} wide><select name="from_account" defaultValue={original?.from_account ?? 'cash'}>
            <option value="cash">{t('من الكاش إلى البنك', 'Cash to bank')}</option>
            <option value="bank">{t('من البنك إلى الكاش', 'Bank to cash')}</option>
          </select></Field>
          <Field title={t('المبلغ', 'Amount')}><input type="number" inputMode="decimal" min="0.01" max="1000000000" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} required />
            {currency === 'SAR' && amount && <PoundEquivalent amount={minor(amount)} lang={lang} />}</Field>
          <Field title={t('العملة', 'Currency')}><select value={currency} onChange={event => setCurrency(event.target.value as CashTransfer['currency'])}>{currencies.map(code => <option key={code}>{code}</option>)}</select></Field>
          {currency !== 'SAR' && <Field title={t('سعر الوحدة بالريال', 'SAR per unit')}><input key={currency} name="rate" type="number" inputMode="decimal" min="0.000001" max="10000" step="0.000001" defaultValue={original?.currency === currency ? original.rate : undefined} required /></Field>}
          <Field title={t('التاريخ', 'Date')}><input type="date" name="date" defaultValue={original?.date ?? today()} required /></Field>
          <Field title={t('ملاحظات (اختياري)', 'Notes (optional)')} wide><textarea name="notes" aria-label={t('ملاحظات (اختياري)', 'Notes (optional)')} rows={3} maxLength={2000} defaultValue={original?.notes ?? ''} /></Field>
        </div>
        {original && <label className="check-field"><input type="checkbox" checked={removing} onChange={event => setRemoving(event.target.checked)} />{t('إلغاء هذا التحويل', 'Void this transfer')}</label>}
      </fieldset>
      {error && <p className="error-box" role="alert">{error}</p>}
      <footer className="dialog-actions"><button className="btn secondary" type="button" onClick={close} disabled={busy}>{t('رجوع', 'Back')}</button>
        <button className={'btn ' + (removing ? 'danger' : 'primary')} disabled={busy}>{removing ? <Trash2 size={16} /> : <Check size={16} />}{busy ? t('جارٍ الحفظ…', 'Saving…') : removing ? t('تأكيد إلغاء التحويل', 'Confirm void transfer') : t('حفظ التحويل', 'Save transfer')}</button></footer>
    </form>
  </dialog>;
}
