'use client';

import { useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Ban, Box, CalendarDays, CircleDollarSign, Download, FileText, History, Package, Pencil, Plus, ReceiptText, Search, Ship, ShoppingBag, Wallet } from 'lucide-react';
import { baseAmount, cashAmount, currencies, debtBalance, debtPrincipal, debtSide, inventory, kindLabels, money, summary, type Container, type Dataset, type Entry, type Kind, type Lang } from '@/lib/domain';
import { type Editor, translate } from './forms';
import { containerCost } from './reports';

const entryIcon = { funding: ArrowDownLeft, borrow: ArrowDownLeft, collect: ArrowDownLeft, lend: ArrowUpRight,
  expense: ReceiptText, asset: Box, purchase: ShoppingBag, repay: ArrowUpRight };

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty"><FileText size={23} /><p>{children}</p></div>;
}
export function EntryTable({ entries, lang, onReceipt, edit, compact = false }: {
  entries: Entry[]; lang: Lang; onReceipt: (path: string) => void; edit?: (editor: Editor) => void; compact?: boolean;
}) {
  const t = translate(lang);
  if (!entries.length) return <Empty>{t('لا توجد عمليات لعرضها.', 'No transactions to display.')}</Empty>;
  return <div className="table-scroll" tabIndex={0} aria-label={t('الحركات المالية', 'Transactions')}><table className={'entries-table' + (compact ? ' compact' : '')}>
    <thead><tr><th scope="col">{t('العملية', 'Transaction')}</th><th scope="col">{t('التاريخ', 'Date')}</th>
      {!compact && <th scope="col">{t('التصنيف', 'Category')}</th>}<th scope="col">{t('المبلغ', 'Amount')}</th>
      {!compact && <><th scope="col">{t('بالريال', 'In SAR')}</th><th scope="col">{t('الفاتورة', 'Receipt')}</th></>}
      {edit && <th scope="col">{t('إدارة الحركة', 'Manage transaction')}</th>}</tr></thead>
    <tbody>{entries.map(e => {
      const Icon = entryIcon[e.kind];
      return <tr key={e.id} className={e.voided_at ? 'voided-row' : undefined}>
        <td><div className="entry-name"><span className={'entry-icon ' + (cashAmount(e) > 0 ? 'positive' : 'neutral')}><Icon size={16} /></span>
          <div><strong>{e.description}</strong><small>{e.party} · {t(...kindLabels[e.kind])}{e.opening && <> · {t('رصيد افتتاحي', 'Opening balance')}</>}</small>
            {e.voided_at && <span className="tag void-tag">{t('ملغاة', 'Voided')}</span>}</div></div></td>
        <td data-label={t('التاريخ', 'Date')}><bdi className="muted">{e.date}</bdi></td>
        {!compact && <td data-label={t('التصنيف', 'Category')}><span className="tag">{e.category}</span><small className="table-sub">{e.scope === 'personal' ? t('شخصي', 'Personal') : t('تجاري', 'Business')}</small></td>}
        <td data-label={t('المبلغ', 'Amount')} className="number"><bdi>{money(e.amount, e.currency, lang)}</bdi>{e.kind === 'purchase' && e.paid < e.amount && <small className="table-sub">{t('مدفوع', 'Paid')}: <bdi>{money(e.paid, e.currency, lang)}</bdi></small>}</td>
        {!compact && <><td data-label={t('بالريال', 'In SAR')} className="number"><bdi>{money(baseAmount(e), 'SAR', lang)}</bdi>{e.currency !== 'SAR' && <small className="table-sub"><bdi>× {e.rate}</bdi></small>}</td>
          <td data-label={t('الفاتورة', 'Receipt')}>{e.receipt_path ? <button className="icon-btn" onClick={() => onReceipt(e.receipt_path!)} aria-label={t('تنزيل الفاتورة', 'Download receipt')}><Download size={16} /></button> : '—'}</td></>}
        {edit && <td className="entry-actions" data-label={t('إدارة الحركة', 'Manage transaction')}><div className="actions">
          {!e.voided_at && <><button className="icon-btn" onClick={() => edit({ type: 'entry', original: e })} aria-label={t('تصحيح الحركة', 'Correct transaction')} title={t('تصحيح الحركة', 'Correct transaction')}><Pencil size={16} /></button>
            <button className="icon-btn" onClick={() => edit({ type: 'void', original: e })} aria-label={t('إلغاء الحركة', 'Void transaction')} title={t('إلغاء الحركة', 'Void transaction')}><Ban size={16} /></button></>}
          {e.revision > 1 && <button className="icon-btn" onClick={() => edit({ type: 'history', original: e })} aria-label={t('سجل التغييرات', 'Change history')} title={t('سجل التغييرات', 'Change history')}><History size={16} /></button>}
        </div></td>}
      </tr>;
    })}</tbody>
  </table></div>;
}

export function Dashboard({ data, entries, lang, navigate, onReceipt, edit }: {
  data: Dataset; entries: Entry[]; lang: Lang; navigate: (section: 'ledger' | 'debts' | 'shipments' | 'inventory') => void; onReceipt: (path: string) => void; edit: (editor: Editor) => void;
}) {
  const t = translate(lang), totals = summary(entries);
  const metrics = [
    { label: t('إجمالي المشتريات', 'Total purchases'), value: totals.purchases, icon: ShoppingBag, tone: 'green', note: t('قيمة البضاعة المسجلة', 'Recorded stock value') },
    { label: t('ديون لنا', 'Receivables'), value: totals.receivable, icon: ArrowDownLeft, tone: 'blue', note: t('المبالغ المتبقية للتحصيل', 'Outstanding to collect') },
    { label: t('ديون علينا', 'Payables'), value: totals.payable, icon: ArrowUpRight, tone: 'amber', note: t('المبالغ المتبقية للسداد', 'Outstanding to repay') },
  ];
  const breakdown = (['business', 'personal'] as const).map(scope => ({
    name: scope === 'business' ? t('مصاريف تشغيلية', 'Operating expenses') : t('مصاريف شخصية', 'Personal expenses'),
    value: entries.filter(e => e.scope === scope && e.kind === 'expense').reduce((sum, e) => sum + baseAmount(e), 0),
  }));
  const balances = currencies.map(currency => ({
    currency, value: entries.filter(e => e.currency === currency).reduce((sum, e) => sum + cashAmount(e), 0),
  })).filter(balance => balance.value);
  return <>
    {!data.entries.length && !data.products.length && <section className="panel welcome-panel">
      <div><span className="eyebrow">{t('فرع جدة', 'JEDDAH BRANCH')}</span><h2>{t('ابدأ سجل الفرع', 'Start your branch ledger')}</h2>
        <p>{t('سجّل الرصيد والديون القائمة، أو أضف أول صنف لتسجيل المشتريات.', 'Record opening balances and debts, or add your first product to record purchases.')}</p></div>
      <div className="actions"><button className="btn primary" onClick={() => edit({ type: 'entry', kind: 'funding' })}><Wallet size={17} />{t('تسجيل رصيد', 'Record balance')}</button>
        <button className="btn secondary" onClick={() => navigate('inventory')}><Package size={17} />{t('فتح المخزون', 'Open inventory')}</button></div>
    </section>}
    <div className="metric-grid">
      <article className="metric metric-feature"><div className="metric-top"><span>{t('صافي الحركة النقدية', 'Net cash movement')}</span><span className="metric-icon"><Wallet size={19} /></span></div>
        <div className="metric-value"><bdi>{money(totals.cash, 'SAR', lang)}</bdi></div>
        <div className="metric-note">{t('مكافئ الريال وفق الأسعار المسجلة', 'SAR equivalent at recorded rates')}</div>
      </article>
      {metrics.map(({ label, value, icon: Icon, tone, note }) => <article className="metric" key={label}>
        <div className="metric-top"><span>{label}</span><span className={'metric-icon ' + tone}><Icon size={19} /></span></div>
        <div className="metric-value"><bdi>{money(value, 'SAR', lang)}</bdi></div><div className="metric-note">{note}</div>
      </article>)}
    </div>
    <div className="dashboard-grid">
      <section className="panel chart-panel">
        <div className="panel-head"><div><h2>{t('المصاريف حسب النطاق', 'Expenses by scope')}</h2><p>{t('إجمالي المصاريف المسجلة بالريال', 'Recorded expenses in SAR')}</p></div><span className="metric-icon green"><CircleDollarSign size={20} /></span></div>
        <div className="chart-value"><bdi>{money(totals.expenses, 'SAR', lang)}</bdi></div>
        <div className="segmented-bar" aria-hidden="true">{totals.expenses ? breakdown.map((item, i) => <span className={'segment segment-' + i} key={item.name} style={{ width: item.value / totals.expenses * 100 + '%' }} />) : null}</div>
        <div className="legend">{breakdown.map((item, i) => <div key={item.name}><span className={'legend-dot segment-' + i} /><span>{item.name}</span><strong><bdi>{money(item.value, 'SAR', lang)}</bdi></strong></div>)}</div>
      </section>
      <section className="panel chart-panel">
        <div className="panel-head"><div><h2>{t('النقد حسب العملة', 'Cash by currency')}</h2><p>{t('صافي المقبوض والمدفوع بالعملة الأصلية', 'Net cash in each original currency')}</p></div><span className="metric-icon blue"><Wallet size={19} /></span></div>
        <div className="balances">{balances.length ? balances.map(b => <div key={b.currency}><span className="currency-pill">{b.currency}</span><strong><bdi>{money(b.value, b.currency, lang)}</bdi></strong></div>) : <Empty>{t('تظهر الأرصدة عند تسجيل الحركات.', 'Balances appear after recording transactions.')}</Empty>}</div>
      </section>
    </div>
    <section className="panel">
      <div className="panel-head"><div><h2>{t('أحدث العمليات', 'Recent transactions')}</h2><p>{t('آخر الحركات المسجلة في حسابات جدة', 'Latest activity in the Jeddah ledger')}</p></div>
        <button className="btn secondary" onClick={() => navigate('ledger')}>{t('عرض السجل', 'View ledger')} <ArrowUpRight size={15} /></button>
      </div>
      <EntryTable entries={entries.slice(0, 5)} lang={lang} onReceipt={onReceipt} compact />
    </section>
    <div className="dashboard-links">
      <button className="panel quick-link" onClick={() => navigate('debts')}><span className="metric-icon amber"><CircleDollarSign size={20} /></span><span><strong>{t('متابعة الديون', 'Track debts')}</strong><small>{entries.filter(e => debtPrincipal(e) > 0 && debtBalance(e, entries) > 0).length} {t('التزامات ومستحقات مفتوحة', 'open balances')}</small></span><ArrowUpRight size={17} /></button>
      <button className="panel quick-link" onClick={() => navigate('shipments')}><span className="metric-icon blue"><Ship size={20} /></span><span><strong>{t('الحاويات والشحن', 'Containers and shipping')}</strong><small>{data.containers.filter(c => c.status === 'preparing').length} {t('حاوية قيد التجهيز', 'containers preparing')}</small></span><ArrowUpRight size={17} /></button>
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
  const items = entries.filter(e => (kind === 'receipts' ? Boolean(e.receipt_path) : !kind || kind === e.kind) &&
    (showVoided || !e.voided_at) && (!scope || scope === e.scope) && (!month || e.date.startsWith(month)) &&
    [e.party, e.description, e.category, e.currency, ...kindLabels[e.kind]].some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  return <section className="panel">
    <div className="filters ledger-filters">
      <label className="field search-field"><span>{t('بحث', 'Search')}</span><span className="search-input"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('جهة، وصف أو تصنيف', 'Party, description, or category')} /></span></label>
      <label className="field"><span>{t('النطاق', 'Scope')}</span><select value={scope} onChange={e => setScope(e.target.value)}><option value="">{t('كل العمليات', 'All scopes')}</option><option value="business">{t('تجاري', 'Business')}</option><option value="personal">{t('شخصي', 'Personal')}</option></select></label>
      <label className="field"><span>{t('الشهر', 'Month')}</span><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>
      <label className="check-field"><input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />{t('إظهار الحركات الملغاة', 'Show voided transactions')}</label>
    </div>
    <p className="result-count">{items.length} {t('عملية', 'transactions')}</p>
    <EntryTable entries={items} lang={lang} onReceipt={onReceipt} edit={edit} />
  </section>;
}

export function Debts({ entries, lang, edit }: { entries: Entry[]; lang: Lang; edit: (editor: Editor) => void }) {
  const t = translate(lang);
  const [side, setSide] = useState<'all' | 'receivable' | 'payable'>('all');
  const [showClosed, setShowClosed] = useState(false);
  const [party, setParty] = useState('');
  const items = entries.filter(e => debtPrincipal(e) > 0 && (side === 'all' || debtSide(e) === side) &&
    (showClosed || debtBalance(e, entries) > 0) && e.party.toLowerCase().includes(party.trim().toLowerCase()));
  return <>
    <section className="panel filters debt-filters">
      <label className="field"><span>{t('الاتجاه', 'Direction')}</span><select value={side} onChange={e => setSide(e.target.value as typeof side)}><option value="all">{t('الكل', 'All')}</option><option value="receivable">{t('ديون لنا', 'Receivables')}</option><option value="payable">{t('ديون علينا', 'Payables')}</option></select></label>
      <label className="field"><span>{t('كشف حساب الجهة', 'Party statement')}</span><input value={party} onChange={e => setParty(e.target.value)} placeholder={t('ابحث باسم الجهة', 'Search by party')} /></label>
      <label className="check-field"><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} /> {t('إظهار المسدّد', 'Show settled')}</label>
    </section>
    {!items.length && <section className="panel"><Empty>{t('لا توجد ديون تطابق الاختيار.', 'No debts match these filters.')}</Empty></section>}
    <div className="cards">{items.map(e => {
      const balance = debtBalance(e, entries), payable = debtSide(e) === 'payable', payments = entries.filter(row => row.settles_id === e.id);
      return <article className="panel record-card" key={e.id}>
        <div className="card-heading"><span className={'metric-icon ' + (payable ? 'amber' : 'blue')}>{payable ? <ArrowUpRight size={19} /> : <ArrowDownLeft size={19} />}</span><span className="tag">{balance === 0 ? t('مسدّد', 'Settled') : payable ? t('علينا', 'Payable') : t('لنا', 'Receivable')}</span></div>
        <h2>{e.party}</h2><p>{e.description}</p>
        <div className="debt-total"><div><small>{t('المتبقي', 'Outstanding')}</small><strong><bdi>{money(balance, e.currency, lang)}</bdi></strong></div><div><small>{t('أصل الدين', 'Principal')}</small><bdi>{money(debtPrincipal(e), e.currency, lang)}</bdi></div></div>
        <div className="meta-line"><CalendarDays size={15} /> <bdi>{e.date}</bdi><span>·</span>{e.scope === 'business' ? t('تجاري', 'Business') : t('شخصي', 'Personal')}</div>
        {payments.length > 0 && <details className="detail"><summary>{payments.length} {t('دفعة مسجلة', 'recorded payments')}</summary>
          {payments.map(p => <div className="split-line" key={p.id}><bdi>{p.date}</bdi><bdi>{money(p.amount, p.currency, lang)}</bdi></div>)}</details>}
        {balance > 0 && <button className="btn secondary" onClick={() => edit({ type: 'entry', kind: payable ? 'repay' : 'collect', debt: e })}><Plus size={16} />{t('تسجيل دفعة', 'Record settlement')}</button>}
      </article>;
    })}</div>
  </>;
}

export function Inventory({ data, lang }: { data: Dataset; lang: Lang }) {
  const t = translate(lang);
  if (!data.products.length) return <section className="panel"><Empty>{t('أضف أول صنف ثم سجّل عملية شراء.', 'Add a product, then record its first purchase.')}</Empty></section>;
  return <div className="cards">{data.products.map(p => {
    const stock = inventory(data, p.id);
    return <article className="panel record-card" key={p.id}>
      <div className="card-heading"><span className="metric-icon green"><Package size={20} /></span><span className="tag">{p.category}</span></div>
      <h2>{p.name}</h2><p>{p.expiry ? t('الصلاحية: ', 'Expiry: ') + p.expiry : p.unit}</p>
      <div className="stock-grid">{[[t('المشتَرى', 'Purchased'), stock.purchased], [t('المحمّل', 'Loaded'), stock.loaded], [t('المتبقي', 'In stock'), stock.remaining]].map(([label, value]) =>
        <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
      <div className="split-line"><span>{t('متوسط تكلفة الوحدة', 'Avg. unit cost')}</span><bdi>{money(Math.round(stock.unitCost), 'SAR', lang)}</bdi></div>
    </article>;
  })}</div>;
}

export function Shipments({ data, lang, edit, advance, updating }: {
  data: Dataset; lang: Lang; edit: (editor: Editor) => void; advance: (container: Container) => void; updating: string;
}) {
  const t = translate(lang);
  const status = { preparing: t('قيد التجهيز', 'Preparing'), shipped: t('تم الشحن', 'Shipped'), arrived: t('وصلت', 'Arrived') };
  if (!data.containers.length) return <section className="panel"><Empty>{t('أضف حاوية لبدء ربط الأصناف ومصاريف الشحن.', 'Add a container to start tracking stock and shipping costs.')}</Empty></section>;
  return <div className="cards">{data.containers.map(c => {
    const cost = containerCost(data, c.id);
    return <article className="panel record-card" key={c.id}>
      <div className="card-heading"><span className="metric-icon blue"><Ship size={21} /></span><span className="tag">{status[c.status]}</span></div>
      <h2><bdi>{c.name}</bdi></h2><p>{c.destination}{c.booking && <> · <bdi>{c.booking}</bdi></>}</p>
      <div className="split-line"><span>{t('تكلفة البضاعة عند التحميل', 'Stock cost at loading')}</span><bdi>{money(cost.goods, 'SAR', lang)}</bdi></div>
      <div className="split-line"><span>{t('النقل والشحن', 'Freight and shipping')}</span><bdi>{money(cost.shipping, 'SAR', lang)}</bdi></div>
      <div className="split-line total-line"><strong>{t('إجمالي التكلفة المسجلة', 'Total recorded cost')}</strong><strong><bdi>{money(cost.total, 'SAR', lang)}</bdi></strong></div>
      {cost.lines.length > 0 && <details className="detail"><summary>{t('البضائع المحملة', 'Loaded stock')} · {cost.lines.length}</summary>{cost.lines.map(line => {
        const product = data.products.find(p => p.id === line.product_id);
        return <div className="split-line" key={line.id}><span>{product?.name}</span><span>{line.quantity} {product?.unit}</span></div>;
      })}</details>}
      <div className="actions">
        {c.status === 'preparing' && <button className="btn secondary" onClick={() => edit({ type: 'load', container: c })}><Plus size={15} />{t('تحميل بضاعة', 'Load stock')}</button>}
        <button className="btn secondary" onClick={() => edit({ type: 'entry', kind: 'expense', container: c })}>{t('إضافة تكلفة', 'Add cost')}</button>
        {c.status !== 'arrived' && <button className="btn secondary" disabled={Boolean(updating) || (c.status === 'preparing' && !cost.lines.length)} onClick={() => advance(c)}>{updating === c.id ? t('جارٍ التحديث…', 'Updating…') : c.status === 'preparing' ? t('تسجيل الشحن', 'Mark shipped') : t('تسجيل الوصول', 'Mark arrived')}</button>}
      </div>
    </article>;
  })}</div>;
}
