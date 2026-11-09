'use client';

import { useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Ban, Box, CircleDollarSign, Download, FileText, History, Pencil, ReceiptText, Search, Ship, ShoppingBag, Wallet } from 'lucide-react';
import { baseAmount, cashAmount, currencies, kindLabels, summary, type Dataset, type Entry, type Kind, type Lang } from '@/lib/domain';
import { MoneyAmount } from './money-amount';
import { invoiceTotals, invoiceVatPercent } from '@/lib/purchases';
import { type Editor, translate } from './forms';

const entryIcon = { funding: ArrowDownLeft, borrow: ArrowDownLeft, collect: ArrowDownLeft, lend: ArrowUpRight,
  expense: ReceiptText, asset: Box, purchase: ShoppingBag, repay: ArrowUpRight };

function InvoiceDetail({ entry, lang }: { entry: Entry; lang: Lang }) {
  const t = translate(lang);
  const items = entry.invoice_items;
  if (!items) return null;
  const totals = invoiceTotals(items);
  const method = { cash: t('نقدي', 'Cash'), bank: t('تحويل بنكي', 'Bank transfer'), card: t('بطاقة', 'Card') }[entry.method];
  return <details className="invoice-detail">
    <summary>{t('تفاصيل الفاتورة', 'Invoice details')}</summary>
    <ul>{items.map((item, index) => <li key={index}><strong>{item.name}</strong>
      <span><bdi>{item.quantity}</bdi> {item.unit} × <MoneyAmount amount={item.unit_price} currency={entry.currency} lang={lang} /></span></li>)}</ul>
    {totals && <dl>
      <div><dt>{t('قبل الضريبة', 'Before VAT')}</dt><dd><MoneyAmount amount={totals.subtotal} currency={entry.currency} lang={lang} /></dd></div>
      <div><dt>{t('الضريبة', 'VAT')} <bdi>{invoiceVatPercent}%</bdi></dt><dd><MoneyAmount amount={totals.vat} currency={entry.currency} lang={lang} /></dd></div>
      <div><dt>{t('طريقة الدفع', 'Payment method')}</dt><dd>{method}</dd></div>
    </dl>}
  </details>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty"><FileText size={23} /><p>{children}</p></div>;
}
export function EntryTable({ entries, lang, onReceipt, edit, compact = false, purchases = false, expenses = false }: {
  entries: Entry[]; lang: Lang; onReceipt: (path: string) => void; edit?: (editor: Editor) => void; compact?: boolean; purchases?: boolean; expenses?: boolean;
}) {
  const t = translate(lang);
  if (!entries.length) return <Empty>{t('لا توجد عمليات لعرضها.', 'No transactions to display.')}</Empty>;
  return <div className="table-scroll" tabIndex={0} aria-label={t('الحركات المالية', 'Transactions')}><table className={'entries-table' + (compact ? ' compact' : '')}>
    <thead><tr><th scope="col">{purchases ? t('الفاتورة', 'Invoice') : expenses ? t('المصروف', 'Expense') : t('العملية', 'Transaction')}</th><th scope="col">{t('التاريخ', 'Date')}</th>
      {!compact && !purchases && <th scope="col">{t('التصنيف', 'Category')}</th>}<th scope="col">{purchases ? t('إجمالي الفاتورة', 'Invoice total') : t('المبلغ', 'Amount')}</th>
      {!compact && !purchases && <th scope="col">{t('بالريال', 'In SAR')}</th>}
      {!compact && <th scope="col">{t('المرفق', 'Attachment')}</th>}
      {edit && <th scope="col">{t('إدارة الحركة', 'Manage transaction')}</th>}</tr></thead>
    <tbody>{entries.map(e => {
      const Icon = entryIcon[e.kind];
      const editLabel = e.invoice_items ? t('تعديل الفاتورة', 'Edit invoice') : e.kind === 'expense' ? t('تعديل المصروف', 'Edit expense') : t('تصحيح الحركة', 'Correct transaction');
      return <tr key={e.id} className={e.voided_at ? 'voided-row' : undefined}>
        <td><div className="entry-name"><span className={'entry-icon ' + (cashAmount(e) > 0 ? 'positive' : 'neutral')}><Icon size={16} /></span>
          <div><strong>{e.invoice_number ? <>{t('فاتورة شراء', 'Purchase invoice')} <bdi>{e.invoice_number}</bdi></> : e.description}</strong>
            {(e.party || !expenses) && <small>{e.party}{!e.invoice_number && !expenses && <>{e.party && ' · '}{t(...kindLabels[e.kind])}</>}{e.opening && <> · {t('رصيد افتتاحي', 'Opening balance')}</>}</small>}
            {!compact && <InvoiceDetail entry={e} lang={lang} />}
            {e.voided_at && <span className="tag void-tag">{t('ملغاة', 'Voided')}</span>}</div></div></td>
        <td data-label={t('التاريخ', 'Date')}><bdi className="muted">{e.date}</bdi></td>
        {!compact && !purchases && <td data-label={t('التصنيف', 'Category')}><span className="tag">{e.category}</span><small className="table-sub">{e.scope === 'personal' ? t('شخصي', 'Personal') : t('تجاري', 'Business')}</small></td>}
        <td data-label={purchases ? t('إجمالي الفاتورة', 'Invoice total') : t('المبلغ', 'Amount')} className="number"><MoneyAmount amount={e.amount} currency={e.currency} lang={lang} />{e.kind === 'purchase' && e.paid < e.amount && <small className="table-sub">{t('المدفوع عند التسجيل', 'Paid at entry')} <MoneyAmount amount={e.paid} currency={e.currency} lang={lang} /></small>}</td>
        {!compact && !purchases && <td data-label={t('بالريال', 'In SAR')} className="number"><MoneyAmount amount={baseAmount(e)} lang={lang} />{e.currency !== 'SAR' && <small className="table-sub"><bdi>× {e.rate}</bdi></small>}</td>}
        {!compact && <td data-label={t('المرفق', 'Attachment')}>{e.receipt_path ? <button className="icon-btn" onClick={() => onReceipt(e.receipt_path!)} aria-label={t('تنزيل المرفق', 'Download attachment')}><Download size={16} /></button> : '—'}</td>}
        {edit && <td className="entry-actions" data-label={t('إدارة الحركة', 'Manage transaction')}><div className="actions">
          {!e.voided_at && <><button className={purchases || expenses ? 'btn secondary' : 'icon-btn'} onClick={() => edit({ type: e.invoice_items ? 'purchase' : 'entry', original: e })} aria-label={editLabel} title={editLabel}><Pencil size={16} />{(purchases || expenses) && t('تعديل', 'Edit')}</button>
            <button className="icon-btn" onClick={() => edit({ type: 'void', original: e })} aria-label={t('إلغاء الحركة', 'Void transaction')} title={t('إلغاء الحركة', 'Void transaction')}><Ban size={16} /></button></>}
          {e.revision > 1 && <button className="icon-btn" onClick={() => edit({ type: 'history', original: e })} aria-label={t('سجل التغييرات', 'Change history')} title={t('سجل التغييرات', 'Change history')}><History size={16} /></button>}
        </div></td>}
      </tr>;
    })}</tbody>
  </table></div>;
}

export function Dashboard({ data, entries, lang, navigate, onReceipt, edit }: {
  data: Dataset; entries: Entry[]; lang: Lang; navigate: (section: 'ledger' | 'debts' | 'shipments') => void; onReceipt: (path: string) => void; edit: (editor: Editor) => void;
}) {
  const t = translate(lang), totals = summary(entries);
  const metrics = [
    { label: t('إجمالي المشتريات', 'Total purchases'), value: totals.purchases, icon: ShoppingBag, tone: 'green' },
    { label: t('ديون لنا', 'Receivables'), value: totals.receivable, icon: ArrowDownLeft, tone: 'blue' },
    { label: t('ديون علينا', 'Payables'), value: totals.payable, icon: ArrowUpRight, tone: 'amber' },
  ];
  const breakdown = (['business', 'personal'] as const).map(scope => ({
    name: scope === 'business' ? t('مصاريف تشغيلية', 'Operating expenses') : t('مصاريف شخصية', 'Personal expenses'),
    value: entries.filter(e => e.scope === scope && e.kind === 'expense').reduce((sum, e) => sum + baseAmount(e), 0),
  }));
  const balances = currencies.map(currency => ({
    currency, value: entries.filter(e => e.currency === currency).reduce((sum, e) => sum + cashAmount(e), 0),
  })).filter(balance => balance.value);
  return <>
    {!data.entries.length && <section className="panel welcome-panel">
      <h2>{t('السجل فارغ', 'Ledger is empty')}</h2>
      <div className="actions"><button className="btn primary" onClick={() => edit({ type: 'entry', kind: 'funding' })}><Wallet size={17} />{t('تسجيل رصيد', 'Record balance')}</button>
        <button className="btn secondary" onClick={() => edit({ type: 'purchase' })}><ShoppingBag size={17} />{t('إضافة فاتورة شراء', 'Add purchase invoice')}</button></div>
    </section>}
    <div className="metric-grid">
      <article className="metric metric-feature"><div className="metric-top"><span>{t('صافي الحركة النقدية', 'Net cash movement')}</span><span className="metric-icon"><Wallet size={19} /></span></div>
        <div className="metric-value"><MoneyAmount amount={totals.cash} lang={lang} /></div>
      </article>
      {metrics.map(({ label, value, icon: Icon, tone }) => <article className="metric" key={label}>
        <div className="metric-top"><span>{label}</span><span className={'metric-icon ' + tone}><Icon size={19} /></span></div>
        <div className="metric-value"><MoneyAmount amount={value} lang={lang} /></div>
      </article>)}
    </div>
    <div className="dashboard-grid">
      <section className="panel chart-panel">
        <div className="panel-head"><h2>{t('المصاريف حسب النطاق', 'Expenses by scope')}</h2><span className="metric-icon green"><CircleDollarSign size={20} /></span></div>
        <div className="chart-value"><MoneyAmount amount={totals.expenses} lang={lang} /></div>
        <div className="segmented-bar" aria-hidden="true">{totals.expenses ? breakdown.map((item, i) => <span className={'segment segment-' + i} key={item.name} style={{ width: item.value / totals.expenses * 100 + '%' }} />) : null}</div>
        <div className="legend">{breakdown.map((item, i) => <div key={item.name}><span className={'legend-dot segment-' + i} /><span>{item.name}</span><strong><MoneyAmount amount={item.value} lang={lang} /></strong></div>)}</div>
      </section>
      <section className="panel chart-panel">
        <div className="panel-head"><h2>{t('النقد حسب العملة', 'Cash by currency')}</h2><span className="metric-icon blue"><Wallet size={19} /></span></div>
        <div className="balances">{balances.length ? balances.map(b => <div key={b.currency}><span className="currency-pill">{b.currency}</span><strong><MoneyAmount amount={b.value} currency={b.currency} lang={lang} /></strong></div>) : <Empty>{t('لا توجد أرصدة.', 'No balances.')}</Empty>}</div>
      </section>
    </div>
    <section className="panel">
      <div className="panel-head"><h2>{t('أحدث العمليات', 'Recent transactions')}</h2>
        <button className="btn secondary" onClick={() => navigate('ledger')}>{t('عرض السجل', 'View ledger')} <ArrowUpRight size={15} /></button>
      </div>
      <EntryTable entries={entries.slice(0, 5)} lang={lang} onReceipt={onReceipt} compact />
    </section>
    <div className="dashboard-links">
      <button className="panel quick-link" onClick={() => navigate('debts')}><span className="metric-icon amber"><CircleDollarSign size={20} /></span><strong>{t('الديون والسلف', 'Debts and advances')}</strong><ArrowUpRight size={17} /></button>
      <button className="panel quick-link" onClick={() => navigate('shipments')}><span className="metric-icon blue"><Ship size={20} /></span><strong>{t('الحاويات والشحن', 'Containers and shipping')}</strong><ArrowUpRight size={17} /></button>
    </div>
  </>;
}

export function Ledger({ entries, lang, kind, onReceipt, edit }: {
  entries: Entry[]; lang: Lang; kind?: Kind | 'receipts'; onReceipt: (path: string) => void; edit: (editor: Editor) => void;
}) {
  const t = translate(lang);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [month, setMonth] = useState('');
  const [showVoided, setShowVoided] = useState(false);
  const search = query.trim().toLowerCase();
  const invoiceList = kind === 'purchase' || kind === 'receipts';
  const items = entries.filter(e => (kind === 'receipts' ? Boolean(e.receipt_path || e.invoice_number) : !kind || kind === e.kind) &&
    (showVoided || !e.voided_at) && (!scope || scope === e.scope) && (!month || e.date.startsWith(month)) &&
    (!search || [e.party, e.description, e.category, e.currency, e.invoice_number ?? '', ...kindLabels[e.kind],
      ...(e.invoice_items?.map(item => item.name) ?? [])].some(value => value.toLowerCase().includes(search))));
  return <section className="panel">
    <div className="filters ledger-filters">
      <label className="field search-field"><span>{t('بحث', 'Search')}</span><span className="search-input"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={invoiceList ? t('جهة، رقم فاتورة أو منتج', 'Party, invoice number, or product') : t('جهة، وصف أو تصنيف', 'Party, description, or category')} /></span></label>
      {kind !== 'purchase' && <label className="field"><span>{t('النطاق', 'Scope')}</span><select value={scope} onChange={e => setScope(e.target.value)}><option value="">{t('كل العمليات', 'All scopes')}</option><option value="business">{t('تجاري', 'Business')}</option><option value="personal">{t('شخصي', 'Personal')}</option></select></label>}
      <label className="field"><span>{t('الشهر', 'Month')}</span><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>
      <label className="check-field"><input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />{t('إظهار الحركات الملغاة', 'Show voided transactions')}</label>
    </div>
    <p className="result-count">{items.length} {t('عملية', 'transactions')}</p>
    <EntryTable entries={items} lang={lang} onReceipt={onReceipt} edit={edit} purchases={kind === 'purchase'} expenses={kind === 'expense'} />
  </section>;
}
