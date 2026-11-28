'use client';

import { useState } from 'react';
import { ArrowLeft, Box, Download, Pencil, Plus, Ship } from 'lucide-react';
import { baseAmount, containerStatusLabels, inventory, type Container, type Dataset, type InvoiceLoad, type Lang } from '@/lib/domain';
import { containerReport } from '@/lib/detail-reports';
import { MoneyAmount } from './money-amount';
import { containerCost } from '@/lib/manifest';
import { containerCargo } from '@/lib/container-cargo';
import { CargoModel } from './cargo-model';
import { errorMessage, translate, type Editor } from './forms';
import { Empty } from './views';

function ContainerTotal({ total, lang }: { total: number; lang: Lang }) {
  const t = translate(lang);
  return <div className="split-line total-line">
    <strong>{t('الإجمالي', 'Total')}</strong>
    <strong><MoneyAmount amount={total} lang={lang} /></strong>
  </div>;
}

export function Shipments({ data, lang, selected, select, edit, advance, updating, onReceipt }: {
  data: Dataset; lang: Lang; selected: string | null; select: (id: string | null) => void;
  edit: (editor: Editor) => void; advance: (container: Container) => void; updating: string;
  onReceipt: (path: string) => void;
}) {
  const t = translate(lang);
  const [modelId, setModelId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const status = (value: Container['status']) => t(containerStatusLabels[value][0], containerStatusLabels[value][1]);
  const editLabel = t('تعديل الحاوية', 'Edit container');
  const container = data.containers.find(row => row.id === selected);
  async function exportFile(format: 'excel' | 'pdf') {
    if (!container || exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const report = containerReport(data, container, lang);
      const exporter = await import('@/lib/download-report');
      await (format === 'excel' ? exporter.downloadReportExcel(report) : exporter.downloadReportPdf(report));
    } catch (problem) { setExportError(errorMessage(problem)); }
    finally { setExporting(false); }
  }
  if (!data.containers.length) return <section className="panel"><Empty>{t('لا توجد حاويات.', 'No containers.')}</Empty></section>;
  if (!container) return <div className="cards">{data.containers.map(row => {
    const { total } = containerCost(data, row);
    return <article className="panel record-card" key={row.id}>
      <div className="card-heading"><span className="metric-icon blue"><Ship size={21} /></span><span className="tag">{status(row.status)}</span></div>
      <h2><bdi>{row.name}</bdi></h2><p>{row.destination}</p>
      <ContainerTotal total={total} lang={lang} />
      <div className="actions">
        <button className="btn secondary" onClick={() => select(row.id)}>{t('عرض الحاوية', 'Open container')}</button>
        <button className="btn secondary" onClick={() => edit({ type: 'manifest', container: row })}><Pencil size={15} />{editLabel}</button>
      </div>
    </article>;
  })}</div>;

  const cost = containerCost(data, container);
  const invoiceGroups = new Map<string, InvoiceLoad[]>();
  for (const line of cost.invoiceLines) {
    const group = invoiceGroups.get(line.entry_id);
    if (group) group.push(line);
    else invoiceGroups.set(line.entry_id, [line]);
  }
  const loaded = cost.lines.length > 0 || cost.invoiceLines.length > 0;
  const preparing = container.status === 'preparing';
  const canLoadLegacy = preparing && data.products.some(product => inventory(data, product.id).remaining > 0);
  const showModel = modelId === container.id && loaded;

  return <section className="panel record-card shipment-detail">
    <div className="card-heading">
      <button className="btn secondary" onClick={() => select(null)}><ArrowLeft className="shipment-back" size={15} />{t('كل الحاويات', 'All containers')}</button>
      <span className="tag">{status(container.status)}</span>
    </div>
    <h2><bdi>{container.name}</bdi></h2>
    <p>{container.destination}{container.booking && <> · <bdi>{container.booking}</bdi></>}</p>
    <div className="actions">
      <button className="btn primary" onClick={() => edit({ type: 'manifest', container })}><Pencil size={15} />{editLabel}</button>
      {canLoadLegacy && <button className="btn secondary" onClick={() => edit({ type: 'load', container })}>{t('تحميل أصناف سابقة', 'Load legacy stock')}</button>}
      <button className="btn secondary" onClick={() => edit({ type: 'entry', kind: 'expense', expenseOnly: true, container })}>
        <Plus size={15} />{t('إضافة مصروف', 'Add expense')}
      </button>
      {container.status !== 'arrived' && <button className="btn secondary" disabled={Boolean(updating) || (preparing && !loaded)} onClick={() => advance(container)}>
        {updating === container.id ? t('جارٍ التحديث…', 'Updating…') : preparing ? t('تسجيل الشحن', 'Mark shipped') : t('تسجيل الوصول', 'Mark arrived')}
      </button>}
    </div>
    <div className="actions shipment-exports" aria-label={t('تصدير الحاوية', 'Export container')}>
      <button className="btn secondary" disabled={exporting} onClick={() => exportFile('excel')}><Download size={16} />{t('تصدير Excel', 'Export Excel')}</button>
      <button className="btn secondary" disabled={exporting} onClick={() => exportFile('pdf')}><Download size={16} />{t('تصدير PDF', 'Export PDF')}</button>
      {exporting && <span role="status">{t('جارٍ التصدير…', 'Exporting…')}</span>}
    </div>
    {exportError && <p className="error-box" role="alert">{exportError}</p>}
    <div className="manifest-picker">
      <div className="manifest-view-switch">
        <h3>{t('الحمولة', 'Manifest')}</h3>
        {loaded && <div className="actions purchase-switch" role="group" aria-label={t('عرض الحمولة', 'Manifest view')}>
          <button className="btn secondary" aria-pressed={!showModel} onClick={() => setModelId(null)}>{t('القائمة', 'List')}</button>
          <button className="btn secondary" aria-pressed={showModel} onClick={() => setModelId(container.id)}><Box size={16} />{t('عرض 3D', '3D view')}</button>
        </div>}
      </div>
      {showModel ? <CargoModel key={container.id} items={containerCargo(data, cost)} lang={lang} onReceipt={onReceipt} /> : <>
      {!loaded && <Empty>{t('الحمولة فارغة.', 'The manifest is empty.')}</Empty>}
      {data.entries.filter(entry => invoiceGroups.has(entry.id)).map(entry => <section className="purchase-item" key={entry.id}>
        <div className="manifest-invoice-head">
          <div><strong>{t('فاتورة', 'Invoice')} <bdi>{entry.invoice_number}</bdi></strong><small>{entry.party} · <bdi>{entry.date}</bdi></small></div>
          {entry.receipt_path && <button className="icon-btn" aria-label={t('تنزيل الفاتورة', 'Download invoice')} onClick={() => onReceipt(entry.receipt_path!)}><Download size={16} /></button>}
        </div>
        {invoiceGroups.get(entry.id)?.sort((a, b) => a.item_index - b.item_index).map(line => {
          const item = entry.invoice_items?.[line.item_index];
          if (!item) return null;
          return <div className="split-line" key={line.item_index}><div><strong>{item.name}</strong>{item.export_excluded && <small>{t('مستبعد من الكشف', 'Excluded from statement')}</small>}</div><span><bdi>{line.quantity}</bdi> {item.unit}</span></div>;
        })}
      </section>)}
      {cost.lines.length > 0 && <section className="purchase-item">
        <strong>{t('أصناف سابقة', 'Legacy stock')}</strong>
        {cost.lines.map(line => {
          const product = data.products.find(p => p.id === line.product_id);
          return <div className="split-line" key={line.id}><strong>{product?.name}</strong><span><bdi>{line.quantity}</bdi> {product?.unit}</span></div>;
        })}
      </section>}
      </>}
    </div>
    <section className="manifest-picker" aria-labelledby="shipment-expenses-heading">
      <div className="manifest-view-switch"><h3 id="shipment-expenses-heading">{t('مصاريف الحاوية', 'Container expenses')}</h3>
        <button className="btn secondary" onClick={() => edit({ type: 'manifest', container })}><Plus size={15} />{t('اختيار مصروف مسجل', 'Select an existing expense')}</button>
      </div>
      {!cost.expenses.length && <Empty>{t('لا توجد مصاريف مرتبطة.', 'No linked expenses.')}</Empty>}
      {cost.expenses.map(expense => <article className="purchase-item" key={expense.id}>
        <div className="manifest-invoice-head"><div><strong>{expense.category} · {expense.description}</strong><small>{expense.party} · <bdi>{expense.date}</bdi></small></div>
          <button className="icon-btn" aria-label={t('تعديل المصروف', 'Edit expense') + ' · ' + expense.description} onClick={() => edit({ type: 'entry', kind: 'expense', expenseOnly: true, original: expense })}><Pencil size={16} /></button>
        </div>
        <MoneyAmount amount={baseAmount(expense)} lang={lang} />
        {expense.notes && <p className="record-note">{expense.notes}</p>}
      </article>)}
    </section>
    <div className="manifest-picker">
      <div className="split-line"><span>{t('تكلفة المنتجات عند التحميل', 'Product cost at loading')}</span><MoneyAmount amount={cost.goods} lang={lang} /></div>
      <div className="split-line"><span>{t('مصاريف الحاوية', 'Container expenses')}</span><MoneyAmount amount={cost.shipping} lang={lang} /></div>
      <ContainerTotal total={cost.total} lang={lang} />
    </div>
  </section>;
}
