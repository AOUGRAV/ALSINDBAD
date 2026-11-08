'use client';

import { ArrowLeft, Download, Pencil, Plus, Ship } from 'lucide-react';
import { inventory, money, type Container, type Dataset, type InvoiceLoad, type Lang } from '@/lib/domain';
import { translate, type Editor } from './forms';
import { containerCost } from './reports';
import { Empty } from './views';

export function Shipments({ data, lang, selected, select, edit, advance, updating, onReceipt }: {
  data: Dataset; lang: Lang; selected: string | null; select: (id: string | null) => void;
  edit: (editor: Editor) => void; advance: (container: Container) => void; updating: string;
  onReceipt: (path: string) => void;
}) {
  const t = translate(lang);
  const status = { preparing: t('قيد التجهيز', 'Preparing'), shipped: t('تم الشحن', 'Shipped'), arrived: t('وصلت', 'Arrived') };
  const container = data.containers.find(row => row.id === selected);
  if (!data.containers.length) return <section className="panel"><Empty>{t('لا توجد حاويات.', 'No containers.')}</Empty></section>;
  if (!container) return <div className="cards">{data.containers.map(row => <article className="panel record-card" key={row.id}>
    <div className="card-heading"><span className="metric-icon blue"><Ship size={21} /></span><span className="tag">{status[row.status]}</span></div>
    <h2><bdi>{row.name}</bdi></h2><p>{row.destination}</p>
    <button className="btn secondary" onClick={() => select(row.id)}>{t('عرض الحاوية', 'Open container')}</button>
  </article>)}</div>;

  const cost = containerCost(data, container.id);
  const invoiceGroups = new Map<string, InvoiceLoad[]>();
  for (const line of cost.invoiceLines) {
    const group = invoiceGroups.get(line.entry_id);
    if (group) group.push(line);
    else invoiceGroups.set(line.entry_id, [line]);
  }
  const loaded = cost.lines.length > 0 || cost.invoiceLines.length > 0;
  const preparing = container.status === 'preparing';
  const canLoadLegacy = preparing && data.products.some(product => inventory(data, product.id).remaining > 0);

  return <section className="panel record-card shipment-detail">
    <div className="card-heading">
      <button className="btn secondary" onClick={() => select(null)}><ArrowLeft className="shipment-back" size={15} />{t('كل الحاويات', 'All containers')}</button>
      <span className="tag">{status[container.status]}</span>
    </div>
    <h2><bdi>{container.name}</bdi></h2>
    <p>{container.destination}{container.booking && <> · <bdi>{container.booking}</bdi></>}</p>
    <div className="actions">
      {preparing && <button className="btn primary" onClick={() => edit({ type: 'manifest', container })}>
        <Pencil size={15} />{loaded ? t('تعديل الحمولة', 'Edit manifest') : t('إضافة فواتير', 'Add invoices')}
      </button>}
      {canLoadLegacy && <button className="btn secondary" onClick={() => edit({ type: 'load', container })}>{t('تحميل أصناف سابقة', 'Load legacy stock')}</button>}
      <button className="btn secondary" onClick={() => edit({ type: 'entry', kind: 'expense', expenseOnly: true, container })}>
        <Plus size={15} />{t('إضافة تكلفة', 'Add cost')}
      </button>
      {container.status !== 'arrived' && <button className="btn secondary" disabled={Boolean(updating) || (preparing && !loaded)} onClick={() => advance(container)}>
        {updating === container.id ? t('جارٍ التحديث…', 'Updating…') : preparing ? t('تسجيل الشحن', 'Mark shipped') : t('تسجيل الوصول', 'Mark arrived')}
      </button>}
    </div>
    <div className="manifest-picker">
      <h3>{t('الحمولة', 'Manifest')}</h3>
      {!loaded && <Empty>{t('الحمولة فارغة.', 'The manifest is empty.')}</Empty>}
      {data.entries.filter(entry => invoiceGroups.has(entry.id)).map(entry => <section className="purchase-item" key={entry.id}>
        <div className="manifest-invoice-head">
          <div><strong>{t('فاتورة', 'Invoice')} <bdi>{entry.invoice_number}</bdi></strong><small>{entry.party} · <bdi>{entry.date}</bdi></small></div>
          {entry.receipt_path && <button className="icon-btn" aria-label={t('تنزيل الفاتورة', 'Download invoice')} onClick={() => onReceipt(entry.receipt_path!)}><Download size={16} /></button>}
        </div>
        {invoiceGroups.get(entry.id)?.sort((a, b) => a.item_index - b.item_index).map(line => {
          const item = entry.invoice_items?.[line.item_index];
          if (!item) return null;
          return <div className="split-line" key={line.item_index}><strong>{item.name}</strong><span><bdi>{line.quantity}</bdi> {item.unit}</span></div>;
        })}
      </section>)}
      {cost.lines.length > 0 && <section className="purchase-item">
        <strong>{t('أصناف سابقة', 'Legacy stock')}</strong>
        {cost.lines.map(line => {
          const product = data.products.find(p => p.id === line.product_id);
          return <div className="split-line" key={line.id}><strong>{product?.name}</strong><span><bdi>{line.quantity}</bdi> {product?.unit}</span></div>;
        })}
      </section>}
    </div>
    <div className="manifest-picker">
      <div className="split-line"><span>{t('تكلفة المنتجات عند التحميل', 'Product cost at loading')}</span><bdi>{money(cost.goods, 'SAR', lang)}</bdi></div>
      <div className="split-line"><span>{t('مصاريف الحاوية', 'Container expenses')}</span><bdi>{money(cost.shipping, 'SAR', lang)}</bdi></div>
      <div className="split-line total-line"><strong>{t('الإجمالي', 'Total')}</strong><strong><bdi>{money(cost.total, 'SAR', lang)}</bdi></strong></div>
    </div>
  </section>;
}
