'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { type CargoItem } from '@/lib/container-cargo';
import { type Lang } from '@/lib/domain';
import { translate } from './forms';
import { MoneyAmount } from './money-amount';

type Point = [x: number, y: number, z: number];
type Box = { x: number; y: number; z: number; w: number; h: number; d: number };
const length = 850, depth = 310, height = 164, pageSize = 10;
const tones = ['#22795b', '#365d86', '#a65d2d', '#635781', '#39736f'];

function project(yaw: number) {
  const radians = yaw * Math.PI / 180;
  const sine = Math.sin(radians), cosine = Math.cos(radians);
  return ([x, y, z]: Point) => {
    const centeredX = x - length / 2, centeredZ = z - depth / 2;
    const distance = centeredX * sine + centeredZ * cosine;
    return { x: 520 + centeredX * cosine - centeredZ * sine, y: 345 + distance * .48 - y * .84, distance };
  };
}

function pallet(index: number) {
  const x = 61 + (index % 5) * 154;
  const z = 34 + Math.floor(index / 5) * 139;
  const base = { x, y: 0, z, w: 112, h: 9, d: 102 };
  const boxes = Array.from({ length: 6 }, (_, boxIndex): Box => ({
    x: x + 8 + (boxIndex % 2) * 49, z: z + 7 + (Math.floor(boxIndex / 2) % 2) * 46,
    y: boxIndex < 4 ? 9 : 45, w: 46, d: 43, h: boxIndex < 4 ? 36 : 25,
  }));
  return { base, boxes };
}

export function CargoModel({ items, lang, onReceipt }: { items: CargoItem[]; lang: Lang; onReceipt: (path: string) => void }) {
  const t = translate(lang);
  const [yaw, setYaw] = useState(-28);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!items.length) return <p className="empty">{t('الحمولة فارغة.', 'The manifest is empty.')}</p>;
  const pageCount = Math.ceil(items.length / pageSize);
  const currentPage = Math.min(page, pageCount - 1);
  const visible = items.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = visible.find(item => item.id === selectedId) ?? visible[0];
  const invoice = selected.invoice;
  const projection = project(yaw);
  const points = (...vertices: Point[]) => vertices.map(vertex => {
    const { x, y } = projection(vertex);
    return x.toFixed(2) + ',' + y.toFixed(2);
  }).join(' ');
  const distance = ({ x, y, z, w, d }: Box) => projection([x + w / 2, y, z + d / 2]).distance;
  const faces = ({ x, y, z, w, h, d }: Box, colors: [string, string, string]) => {
    const side = yaw < 0 ? x : x + w;
    return <>
      <polygon points={points([side, y, z], [side, y + h, z], [side, y + h, z + d], [side, y, z + d])} fill={colors[2]} />
      <polygon points={points([x, y, z + d], [x, y + h, z + d], [x + w, y + h, z + d], [x + w, y, z + d])} fill={colors[1]} />
      <polygon points={points([x, y + h, z], [x + w, y + h, z], [x + w, y + h, z + d], [x, y + h, z + d])} fill={colors[0]} />
    </>;
  };
  const farEnd = yaw < 0 ? length : 0;
  const sorted = visible.map((item, index) => ({ item, index, ...pallet(index) })).sort((a, b) => distance(a.base) - distance(b.base));
  return <div className="cargo-model">
    <div className="cargo-controls">
      <span className="tag">{t('توزيع توضيحي', 'Illustrative layout')}</span>
      <label><span>{t('تدوير العرض', 'Rotate view')}</span><input type="range" min="-38" max="38" value={yaw} dir="ltr"
        onChange={event => setYaw(Number(event.target.value))} /></label>
    </div>
    <div className="cargo-viewport" tabIndex={0} aria-label={t('عرض الحمولة ثلاثي الأبعاد', '3D cargo view')}>
      <svg viewBox="0 0 1040 565" role="group" aria-label={t('الطبليات', 'Pallets')}>
        <polygon className="cargo-floor" points={points([0, 0, 0], [length, 0, 0], [length, 0, depth], [0, 0, depth])} />
        <polygon className="cargo-wall" points={points([0, 0, 0], [length, 0, 0], [length, height, 0], [0, height, 0])} />
        <polygon className="cargo-wall cargo-end" points={points([farEnd, 0, 0], [farEnd, height, 0], [farEnd, height, depth], [farEnd, 0, depth])} />
        {Array.from({ length: 19 }, (_, index) => (index + 1) * length / 20).map(x =>
          <polyline className="cargo-rib" key={x} points={points([x, 0, 0], [x, height, 0])} />)}
        {Array.from({ length: 6 }, (_, index) => (index + 1) * depth / 7).map(z =>
          <polyline className="cargo-rib" key={z} points={points([farEnd, 0, z], [farEnd, height, z])} />)}
        <polyline className="cargo-rim" points={points([0, 0, 0], [0, 0, depth], [length, 0, depth], [length, 0, 0])} />
        {sorted.map(({ item, base, boxes, index }) => <g className="cargo-pallet" key={item.id}
          role="button" tabIndex={0} aria-pressed={selected.id === item.id} aria-label={t('عرض بيانات ', 'Show details for ') + item.name}
          onClick={() => setSelectedId(item.id)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(item.id); }
          }}>
          <title>{item.name}</title>
          <g className="cargo-platform">{faces(base, ['#b3a38e', tones[index % tones.length], '#504537'])}</g>
          {[...boxes].sort((a, b) => a.y - b.y || distance(a) - distance(b)).map((box, boxIndex) =>
            <g className="cargo-carton" key={boxIndex}>{faces(box, ['#efd1a2', '#c89760', '#a97848'])}</g>)}
        </g>)}
        {sorted.map(({ item, base }) => {
          const name = Array.from(item.name);
          const label = name.length > 18 ? name.slice(0, 17).join('') + '…' : item.name;
          const anchor = projection([base.x + base.w / 2, 87, base.z + base.d / 2]);
          const width = Math.max(42, Array.from(label).length * 7 + 17);
          return <g key={item.id} className={'cargo-tag' + (selected.id === item.id ? ' cargo-tag-active' : '')}
            transform={'translate(' + anchor.x + ' ' + anchor.y + ')'} aria-hidden="true" onClick={() => setSelectedId(item.id)}>
            <rect x={-width / 2} y={-17} width={width} height={24} rx={8} />
            <text textAnchor="middle" direction={lang === 'ar' ? 'rtl' : 'ltr'} y={0}>{label}</text>
          </g>;
        })}
      </svg>
    </div>
    {pageCount > 1 && <div className="actions cargo-pagination">
      <button className="btn secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('السابق', 'Previous')}</button>
      <bdi>{currentPage + 1} / {pageCount}</bdi>
      <button className="btn secondary" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>{t('التالي', 'Next')}</button>
    </div>}
    {visible.length > 1 && <label className="field cargo-select"><span>{t('اختيار المنتج', 'Select product')}</span><select value={selected.id} onChange={event => setSelectedId(event.target.value)}>
      {visible.map(item => <option key={item.id} value={item.id}>{item.name}{item.invoice?.invoice_number ? ' · ' + item.invoice.invoice_number : ''}</option>)}
    </select></label>}
    <section className="purchase-item cargo-details" aria-live="polite">
      <div className="manifest-invoice-head"><h3>{selected.name}</h3>
        {invoice?.receipt_path && <button className="icon-btn" aria-label={t('تنزيل الفاتورة', 'Download invoice')} onClick={() => onReceipt(invoice.receipt_path!)}><Download size={16} /></button>}
      </div>
      <dl>
        <div><dt>{t('الكمية المشحونة', 'Loaded quantity')}</dt><dd><bdi>{selected.quantity}</bdi> {selected.unit}</dd></div>
        {invoice && <>
          <div><dt>{t('رقم الفاتورة', 'Invoice number')}</dt><dd><bdi>{invoice.invoice_number}</bdi></dd></div>
          <div><dt>{t('الجهة', 'Supplier')}</dt><dd>{invoice.party}</dd></div>
          <div><dt>{t('تاريخ الفاتورة', 'Invoice date')}</dt><dd><bdi>{invoice.date}</bdi></dd></div>
        </>}
        <div><dt>{t('التكلفة عند التحميل', 'Cost at loading')}</dt><dd><MoneyAmount amount={selected.cost} lang={lang} /></dd></div>
      </dl>
    </section>
  </div>;
}
