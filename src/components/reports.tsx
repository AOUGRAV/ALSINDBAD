'use client';

import { useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { activeEntries, baseAmount, cashAmount, debtBalance, debtPrincipal, debtSide, kindLabels, kinds, today, type Dataset, type Lang } from '@/lib/domain';
import { invoiceLineTotal, invoiceTotals, invoiceVatPercent } from '@/lib/purchases';
import { errorMessage, translate } from './forms';

type Cell = string | number;
type Report = { headers: string[]; rows: Cell[][]; numeric: number[] };
type ReportKind = 'ledger' | 'debts' | 'purchases' | 'prices' | 'containers';
export const reportKinds: Record<ReportKind, [string, string]> = {
  ledger: ['الحركات المالية', 'Transaction ledger'], debts: ['الديون المفتوحة', 'Open debts'],
  purchases: ['فواتير الشراء', 'Purchase invoices'], prices: ['أسعار الشراء', 'Purchase prices'],
  containers: ['تكلفة الحاويات', 'Container costs'],
};
export function containerCost(data: Dataset, id: string) {
  const lines = data.loads.filter(load => load.container_id === id);
  const invoiceLines = data.invoice_loads.filter(load => load.container_id === id);
  const goods = [...lines, ...invoiceLines].reduce((sum, load) => sum + load.cost_sar, 0);
  const shipping = data.entries.filter(e => !e.voided_at && e.container_id === id).reduce((sum, e) => sum + baseAmount(e), 0);
  return { lines, invoiceLines, goods, shipping, total: goods + shipping };
}

async function downloadExcel(report: Report, title: string, range: string, lang: Lang) {
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
  sheet.getCell('A2').value = range;
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

export function Reports({ data, lang }: { data: Dataset; lang: Lang }) {
  const t = translate(lang);
  const [kind, setKind] = useState<ReportKind>('ledger');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState('');
  const [entryKind, setEntryKind] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dated = kind === 'ledger' || kind === 'purchases' || kind === 'prices';
  const invalidRange = dated && !!from && !!to && from > to;
  const entries = activeEntries(data.entries);
  const filtered = entries.filter(e => (!from || e.date >= from) && (!to || e.date <= to));
  const sorted = (rows: Dataset['entries']) => [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const original = t('المبلغ الأصلي', 'Original amount'), currency = t('العملة', 'Currency'), sar = t('القيمة (SAR)', 'Value (SAR)');
  const party = t('الجهة', 'Party'), date = t('التاريخ', 'Date'), type = t('النوع', 'Type'), scopeName = t('النطاق', 'Scope');
  const scopeText = (value: string) => value === 'business' ? t('تجاري', 'Business') : t('شخصي', 'Personal');
  const product = t('المنتج', 'Product'), invoiceNumber = t('رقم الفاتورة', 'Invoice number'), unit = t('الوحدة', 'Unit');
  const report: Report = (() => {
    if (kind === 'debts') return {
      headers: [party, type, scopeName, original, currency, t('المتبقي', 'Outstanding'), sar],
      rows: sorted(entries).filter(e => debtPrincipal(e) && debtBalance(e, entries) > 0).map(e => [e.party,
        debtSide(e) === 'payable' ? t('علينا', 'Payable') : t('لنا', 'Receivable'), scopeText(e.scope),
        debtPrincipal(e) / 100, e.currency, debtBalance(e, entries) / 100, baseAmount(e, debtBalance(e, entries)) / 100]),
      numeric: [3, 5, 6],
    };
    if (kind === 'purchases') return {
      headers: [date, invoiceNumber, party, currency, t('قبل الضريبة', 'Before VAT'), t('الضريبة', 'VAT') + ' ' + invoiceVatPercent + '%',
        t('الإجمالي', 'Total'), t('المدفوع', 'Paid'), sar],
      rows: sorted(filtered.filter(e => e.kind === 'purchase')).map(e => {
        const totals = e.invoice_items && invoiceTotals(e.invoice_items);
        const paid = e.paid + debtPrincipal(e) - debtBalance(e, entries);
        return [e.date, e.invoice_number ?? '—', e.party, e.currency, totals ? totals.subtotal / 100 : '—',
          totals ? totals.vat / 100 : '—', e.amount / 100, paid / 100, baseAmount(e) / 100];
      }),
      numeric: [4, 5, 6, 7, 8],
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
      headers: [date, invoiceNumber, product, party, t('الكمية', 'Quantity'), unit, currency, t('سعر الوحدة', 'Unit price'), t('سعر الوحدة (SAR)', 'Unit price (SAR)'), sar],
      rows: sorted(filtered.filter(e => e.kind === 'purchase')).flatMap((e): Cell[][] => {
        if (e.invoice_items) return e.invoice_items.map(item => [e.date, e.invoice_number ?? '—', item.name, e.party, item.quantity,
          item.unit, e.currency, item.unit_price / 100, baseAmount(e, item.unit_price) / 100, baseAmount(e, invoiceLineTotal(item) ?? 0) / 100]);
        const legacyProduct = data.products.find(p => p.id === e.product_id);
        return [[e.date, '—', legacyProduct?.name ?? '—', e.party, e.quantity, legacyProduct?.unit ?? '—', e.currency,
          e.amount / e.quantity / 100, baseAmount(e) / e.quantity / 100, baseAmount(e) / 100]];
      }),
      numeric: [7, 8, 9],
    };
    return {
      headers: [date, type, party, t('الوصف', 'Description'), t('التصنيف', 'Category'), scopeName, original, currency, t('سعر الصرف', 'FX rate'), sar, t('حركة النقد (SAR)', 'Cash movement (SAR)')],
      rows: sorted(filtered.filter(e => (!entryKind || e.kind === entryKind) && (!scope || e.scope === scope))).map(e =>
        [e.date, e.opening ? t('دين افتتاحي', 'Opening debt') : t(...kindLabels[e.kind]), e.party, e.description, e.category, scopeText(e.scope), e.amount / 100, e.currency, e.rate, baseAmount(e) / 100, cashAmount(e, true) / 100]),
      numeric: [6, 9, 10],
    };
  })();
  if (filter.trim()) report.rows = report.rows.filter(row => row.some(cell => String(cell).toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())));
  const range = dated && (from || to) ? [from || t('البداية', 'Start'), to || today()].join(' — ') : t('كل السجلات', 'All records');
  const title = t(...reportKinds[kind]);
  async function exportFile() {
    setBusy(true);
    setError('');
    try { await downloadExcel(report, title, range, lang); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  return <section className="panel report-panel">
    <div className="panel-head no-print"><h2>{t('إنشاء تقرير', 'Build a report')}</h2>
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
    <div className="report-title"><h2>{title}</h2><p>{range} · {report.rows.length} {t('سجل', 'records')}</p></div>
    <div className="table-scroll" tabIndex={0} aria-label={title}><table className="report-table"><thead><tr>{report.headers.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>
      {report.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{typeof cell === 'number' ? <bdi>{new Intl.NumberFormat(lang === 'ar' ? 'ar-SA' : 'en-GB', { maximumFractionDigits: column === 8 && kind === 'ledger' ? 6 : column === 4 && kind === 'prices' ? 3 : 2 }).format(cell)}</bdi> : cell}</td>)}</tr>)}
    </tbody></table></div>
    {!report.rows.length && <p className="empty">{t('لا توجد سجلات تطابق الفلاتر.', 'No records match these filters.')}</p>}
  </section>;
}
