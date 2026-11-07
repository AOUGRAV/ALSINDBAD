'use client';

import { useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { baseAmount, cashSign, debtBalance, debtPrincipal, debtSide, inventory, kindLabels, kinds, today, type Dataset, type Lang } from '@/lib/domain';
import { errorMessage, translate } from './forms';

type Cell = string | number;
type Report = { headers: string[]; rows: Cell[][]; numeric: number[] };
type ReportKind = 'ledger' | 'debts' | 'products' | 'prices' | 'containers';
export const reportKinds: Record<ReportKind, [string, string]> = {
  ledger: ['الحركات المالية', 'Transaction ledger'], debts: ['الديون المفتوحة', 'Open debts'],
  products: ['المخزون والمشتريات', 'Stock and purchases'], prices: ['أسعار الشراء', 'Purchase prices'],
  containers: ['تكلفة الحاويات', 'Container costs'],
};
export function containerCost(data: Dataset, id: string) {
  const lines = data.loads.filter(load => load.container_id === id);
  const goods = lines.reduce((sum, load) => sum + Math.round(inventory(data, load.product_id).unitCost * load.quantity), 0);
  const shipping = data.entries.filter(e => e.container_id === id).reduce((sum, e) => sum + baseAmount(e), 0);
  return { lines, goods, shipping, total: goods + shipping };
}

async function downloadExcel(report: Report, title: string, range: string, lang: Lang, demo: boolean) {
  const { Workbook } = await import('exceljs');
  const book = new Workbook();
  book.creator = 'ALSINDBAD';
  const sheet = book.addWorksheet('ALSINDBAD', { views: [{ state: 'frozen', ySplit: 4, rightToLeft: lang === 'ar' }] });
  sheet.mergeCells(1, 1, 1, report.headers.length);
  sheet.getCell('A1').value = 'ALSINDBAD  |  ' + title;
  sheet.getCell('A1').font = { size: 17, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153D33' } };
  sheet.getRow(1).height = 33;
  sheet.mergeCells(2, 1, 2, report.headers.length);
  sheet.getCell('A2').value = (demo ? translate(lang)('بيانات تجريبية · ', 'Demo data · ') : '') + range;
  const header = sheet.getRow(4);
  header.values = report.headers;
  header.font = { bold: true, color: { argb: 'FF153D33' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F2EC' } };
  report.headers.forEach((label, i) => {
    sheet.getColumn(i + 1).width = Math.min(48, Math.max(label.length + 5, 17, ...report.rows.slice(0, 100).map(row => String(row[i]).length + 2)));
  });
  for (const values of report.rows) {
    const row = sheet.addRow(values);
    row.alignment = { vertical: 'middle', wrapText: true };
    if (row.number % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7F5' } };
    for (const index of report.numeric) row.getCell(index + 1).numFmt = '#,##0.00';
  }
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: report.headers.length } };
  const bytes = await book.xlsx.writeBuffer();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  link.download = 'ALSINDBAD-' + today() + '.xlsx';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function Reports({ data, lang, demo }: { data: Dataset; lang: Lang; demo: boolean }) {
  const t = translate(lang);
  const [kind, setKind] = useState<ReportKind>('ledger');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState('');
  const [entryKind, setEntryKind] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dated = kind === 'ledger' || kind === 'prices';
  const invalidRange = dated && !!from && !!to && from > to;
  const filtered = data.entries.filter(e => (!from || e.date >= from) && (!to || e.date <= to));
  const sorted = (rows: Dataset['entries']) => [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const original = t('المبلغ الأصلي', 'Original amount'), currency = t('العملة', 'Currency'), sar = t('القيمة (SAR)', 'Value (SAR)');
  const party = t('الجهة', 'Party'), date = t('التاريخ', 'Date'), type = t('النوع', 'Type'), scopeName = t('النطاق', 'Scope');
  const scopeText = (value: string) => value === 'business' ? t('تجاري', 'Business') : t('شخصي', 'Personal');
  const product = t('الصنف', 'Product');
  const report: Report = (() => {
    if (kind === 'debts') return {
      headers: [party, type, scopeName, original, currency, t('المتبقي', 'Outstanding'), sar],
      rows: sorted(data.entries).filter(e => debtPrincipal(e) && debtBalance(e, data.entries) > 0).map(e => [e.party,
        debtSide(e) === 'payable' ? t('علينا', 'Payable') : t('لنا', 'Receivable'), scopeText(e.scope),
        debtPrincipal(e) / 100, e.currency, debtBalance(e, data.entries) / 100, baseAmount(e, debtBalance(e, data.entries)) / 100]),
      numeric: [3, 5, 6],
    };
    if (kind === 'products') return {
      headers: [product, t('التصنيف', 'Category'), t('وحدة القياس', 'Unit'), t('مرات الشراء', 'Purchases'), t('المشتَرى', 'Purchased'),
        t('المحمّل', 'Loaded'), t('المتبقي', 'In stock'), sar, t('الصلاحية', 'Expiry')],
      rows: data.products.map(p => {
        const stock = inventory(data, p.id);
        return [p.name, p.category, p.unit, data.entries.filter(e => e.product_id === p.id).length, stock.purchased, stock.loaded, stock.remaining, stock.value / 100, p.expiry ?? '—'];
      }).sort((a, b) => Number(b[3]) - Number(a[3])),
      numeric: [7],
    };
    if (kind === 'containers') return {
      headers: [t('الحاوية', 'Container'), t('الوجهة', 'Destination'), t('قيمة البضاعة (SAR)', 'Stock value (SAR)'), t('مصاريف الشحن (SAR)', 'Shipping (SAR)'), t('الإجمالي (SAR)', 'Total (SAR)')],
      rows: data.containers.map(c => {
        const cost = containerCost(data, c.id);
        return [c.name, c.destination, cost.goods / 100, cost.shipping / 100, cost.total / 100];
      }),
      numeric: [2, 3, 4],
    };
    if (kind === 'prices') return {
      headers: [date, product, party, t('الكمية', 'Quantity'), currency, t('سعر الوحدة', 'Unit price'), t('سعر الوحدة (SAR)', 'Unit price (SAR)'), sar],
      rows: sorted(filtered.filter(e => e.kind === 'purchase')).map(e => [e.date, data.products.find(p => p.id === e.product_id)?.name ?? '—', e.party, e.quantity,
        e.currency, e.amount / e.quantity / 100, baseAmount(e) / e.quantity / 100, baseAmount(e) / 100]),
      numeric: [5, 6, 7],
    };
    return {
      headers: [date, type, party, t('الوصف', 'Description'), t('التصنيف', 'Category'), scopeName, original, currency, t('سعر الصرف', 'FX rate'), sar, t('حركة النقد (SAR)', 'Cash movement (SAR)')],
      rows: sorted(filtered.filter(e => (!entryKind || e.kind === entryKind) && (!scope || e.scope === scope))).map(e =>
        [e.date, t(...kindLabels[e.kind]), e.party, e.description, e.category, scopeText(e.scope), e.amount / 100, e.currency, e.rate, baseAmount(e) / 100, cashSign(e.kind) * baseAmount(e, e.paid) / 100]),
      numeric: [6, 9, 10],
    };
  })();
  if (filter.trim()) report.rows = report.rows.filter(row => row.some(cell => String(cell).toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())));
  const range = dated && (from || to) ? [from || t('البداية', 'Start'), to || today()].join(' — ') : t('كل السجلات', 'All records');
  const title = t(...reportKinds[kind]);
  async function exportFile() {
    setBusy(true);
    setError('');
    try { await downloadExcel(report, title, range, lang, demo); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  return <section className="panel report-panel">
    <div className="panel-head no-print"><div><h2>{t('إنشاء تقرير', 'Build a report')}</h2><p>{t('اختر نوع التقرير ثم صفِّ البيانات قبل التصدير.', 'Choose a report and filter before exporting.')}</p></div>
      <div className="actions"><button className="btn secondary" disabled={busy || !report.rows.length || invalidRange} onClick={exportFile}><Download size={17} />{busy ? t('جارٍ التصدير…', 'Exporting…') : 'Excel'}</button>
        <button className="btn secondary" disabled={!report.rows.length || invalidRange} onClick={() => window.print()}><Printer size={17} /> PDF</button></div>
    </div>
    <div className="filters no-print">
      <label className="field"><span>{t('نوع التقرير', 'Report type')}</span><select value={kind} onChange={e => { setKind(e.target.value as ReportKind); setFilter(''); }}>{Object.entries(reportKinds).map(([key, labels]) => <option key={key} value={key}>{t(...labels)}</option>)}</select></label>
      {dated && <><label className="field"><span>{t('من تاريخ', 'From date')}</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="field"><span>{t('إلى تاريخ', 'To date')}</span><input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label></>}
      {kind === 'ledger' && <><label className="field"><span>{scopeName}</span><select value={scope} onChange={e => setScope(e.target.value)}><option value="">{t('الكل', 'All')}</option><option value="business">{scopeText('business')}</option><option value="personal">{scopeText('personal')}</option></select></label>
        <label className="field"><span>{type}</span><select value={entryKind} onChange={e => setEntryKind(e.target.value)}><option value="">{t('الكل', 'All')}</option>{kinds.map(k => <option key={k} value={k}>{t(...kindLabels[k])}</option>)}</select></label></>}
      <label className="field"><span>{t('بحث داخل التقرير', 'Search report')}</span><input value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('مورد، صنف أو تصنيف', 'Supplier, product, or category')} /></label>
    </div>
    {invalidRange && <p className="error-box no-print" role="alert">{t('تاريخ النهاية يجب أن يكون بعد البداية.', 'End date must follow the start date.')}</p>}
    {error && <p className="error-box no-print" role="alert">{error}</p>}
    <div className="report-title"><div className="eyebrow">ALSINDBAD / JEDDAH</div><h2>{title}</h2><p>{demo && t('بيانات تجريبية · ', 'Demo data · ')}{range} · {report.rows.length} {t('سجل', 'records')}</p></div>
    <div className="table-scroll" tabIndex={0} aria-label={title}><table className="report-table"><thead><tr>{report.headers.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>
      {report.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{typeof cell === 'number' ? <bdi>{new Intl.NumberFormat(lang === 'ar' ? 'ar-SA' : 'en-GB', { maximumFractionDigits: column === 8 && kind === 'ledger' ? 6 : 2 }).format(cell)}</bdi> : cell}</td>)}</tr>)}
    </tbody></table></div>
    {!report.rows.length && <p className="empty">{t('لا توجد سجلات تطابق الفلاتر.', 'No records match these filters.')}</p>}
  </section>;
}
