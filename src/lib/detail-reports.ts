import { baseAmount, containerStatusLabels, kindLabels, today, type Container, type Dataset, type Lang } from './domain';
import { containerCost } from './manifest';
import { cashAccount, custodyLedger, custodyPeriod } from './custody';
import { poundsFromRiyals } from './pounds';

export type ExportCell = string | number;
export type ExportColumn = { title: string; width: number; format?: 'money' | 'quantity'; direction?: 'rtl' | 'ltr' };
export type ExportTable = { title: string; columns: ExportColumn[]; rows: ExportCell[][] };
export type DetailReport = { title: string; subtitle: string; filename: string; lang: Lang; summary: ExportTable; tables: ExportTable[] };
const money = (amount: number) => amount / 100;
const gbp = (amount: number) => money(poundsFromRiyals(amount));
const textColumn = (title: string, width = 24): ExportColumn => ({ title, width });
const amountColumn = (title: string): ExportColumn => ({ title, width: 19, format: 'money' });
const safeName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100);

export function containerReport(data: Dataset, container: Container, lang: Lang): DetailReport {
  const t = (ar: string, en: string) => lang === 'ar' ? ar : en;
  const cost = containerCost(data, container);
  const invoiceLines = cost.invoiceLines.filter(line => !data.entries.find(entry => entry.id === line.entry_id)?.invoice_items?.[line.item_index]?.export_excluded);
  const goods = [...cost.lines, ...invoiceLines].reduce((sum, line) => sum + line.cost_sar, 0);
  const total = goods + cost.shipping;
  const hasExclusions = invoiceLines.length !== cost.invoiceLines.length;
  const englishName = (item?: { name: string; name_en?: string }) => item?.name_en?.trim() ||
    (item?.name && /[A-Za-z]/.test(item.name) && !/[\u0600-\u06ff]/.test(item.name) ? item.name : '');
  const sar = amountColumn('SAR'), pound = amountColumn('GBP');
  const contents: ExportTable = {
    title: t('محتويات الحاوية', 'Container contents'),
    columns: [textColumn(t('الفاتورة', 'Invoice'), 18), textColumn(t('المورد', 'Supplier'), 25),
      { ...textColumn(t('المنتج (عربي)', 'Product (Arabic)'), 34), direction: 'rtl' },
      { ...textColumn('Product (English)', 42), direction: 'ltr' },
      textColumn(t('الوحدة', 'Unit'), 14), { title: t('الكمية المشحونة', 'Shipped quantity'), width: 20, format: 'quantity' },
      amountColumn(t('تكلفة الوحدة SAR', 'Unit cost SAR')), amountColumn(t('التكلفة SAR', 'Cost SAR')), pound, textColumn(t('ملاحظات الفاتورة', 'Invoice notes'), 36)],
    rows: invoiceLines.map(line => {
      const entry = data.entries.find(row => row.id === line.entry_id);
      const item = entry?.invoice_items?.[line.item_index];
      return [entry?.invoice_number ?? '—', entry?.party ?? '—', item?.name ?? '—', englishName(item), item?.unit ?? '—', line.quantity,
        money(line.cost_sar) / line.quantity, money(line.cost_sar), gbp(line.cost_sar), entry?.notes ?? ''];
    }).concat(cost.lines.map(line => {
      const product = data.products.find(row => row.id === line.product_id);
      return [t('سجل سابق', 'Legacy stock'), '—', product?.name ?? '—', englishName(product), product?.unit ?? '—', line.quantity,
        money(line.cost_sar) / line.quantity, money(line.cost_sar), gbp(line.cost_sar), ''];
    })),
  };
  const expenses: ExportTable = {
    title: t('مصاريف الحاوية', 'Container expenses'),
    columns: [textColumn(t('التاريخ', 'Date'), 24), textColumn(t('نوع المصروف', 'Category')), textColumn(t('الوصف', 'Description'), 36),
      textColumn(t('الجهة', 'Party')), amountColumn(t('المبلغ الأصلي', 'Original amount')), textColumn(t('العملة', 'Currency'), 12), sar, pound, textColumn(t('ملاحظات', 'Notes'), 36)],
    rows: cost.expenses.map(row => [row.date, row.category, row.description, row.party, money(row.amount), row.currency, money(baseAmount(row)), gbp(baseAmount(row)), row.notes ?? '']),
  };
  return {
    title: t('تفاصيل الحاوية', 'Container details') + ' · ' + container.name,
    subtitle: [container.destination, t(containerStatusLabels[container.status][0], containerStatusLabels[container.status][1]), container.booking && t('الحجز', 'Booking') + ' ' + container.booking, today()].filter(Boolean).join(' · '),
    filename: safeName('ALSINDBAD-' + container.name + '-AR-EN'), lang,
    summary: { title: t('ملخص الحاوية', 'Container summary'), columns: [textColumn(t('البند', 'Item'), 38), sar, pound], rows: [
      [hasExclusions ? t('تكلفة البضاعة في الكشف', 'Goods cost in statement') : t('تكلفة البضاعة', 'Goods cost'), money(goods), gbp(goods)],
      [t('مصاريف الحاوية', 'Container expenses'), money(cost.shipping), gbp(cost.shipping)],
      [hasExclusions ? t('إجمالي الكشف', 'Statement total') : t('التكلفة الإجمالية', 'Total cost'), money(total), gbp(total)],
    ] }, tables: [contents, expenses],
  };
}

export function custodyReport(data: Dataset, from: string, to: string, lang: Lang): DetailReport {
  if (from && to && from > to) throw new Error('تحقق من ترتيب التاريخين / Invalid date range');
  const t = (ar: string, en: string) => lang === 'ar' ? ar : en;
  const period = custodyPeriod(custodyLedger(data.entries, data.cash_transfers), from, to);
  const range = from || to ? `${from || t('البداية', 'Start')} — ${to || t('اليوم', 'Today')}` : t('جميع الفترات', 'All dates');
  const account = (value: string) => value === 'cash' ? t('كاش', 'Cash') : t('بنك', 'Bank');
  return {
    title: t('كشف العهدة', 'Custody statement'), subtitle: range, filename: `ALSINDBAD-Custody-${from || 'all'}-${to || today()}`, lang,
    summary: { title: t('ملخص العهدة', 'Custody summary'), columns: [textColumn(t('البند', 'Item'), 38), amountColumn('SAR'), amountColumn('GBP')],
      rows: [
        [t('رصيد بداية الفترة', 'Opening balance'), period.opening], [t('المستلم خلال الفترة', 'Received in period'), period.incoming],
        [t('المصروف خلال الفترة', 'Paid in period'), period.outgoing], [t('المتبقي', 'Closing balance'), period.remaining],
        [t('المتبقي كاش', 'Cash balance'), period.cash], [t('المتبقي في البنك', 'Bank balance'), period.bank],
      ].map(([label, value]) => [label, money(Number(value)), gbp(Number(value))]) },
    tables: [{ title: t('حركات العهدة', 'Custody movements'), columns: [
      textColumn(t('التاريخ', 'Date'), 16), textColumn(t('الحركة', 'Movement'), 20), textColumn(t('الجهة', 'Party'), 26), textColumn(t('الوصف', 'Description'), 36),
      textColumn(t('الحساب', 'Account'), 20), amountColumn(t('وارد SAR', 'Received SAR')), amountColumn(t('وارد GBP', 'Received GBP')),
      amountColumn(t('صادر SAR', 'Paid SAR')), amountColumn(t('صادر GBP', 'Paid GBP')), amountColumn(t('تحويل داخلي SAR', 'Internal transfer SAR')),
      amountColumn(t('الرصيد SAR', 'Balance SAR')), amountColumn(t('الرصيد GBP', 'Balance GBP')), textColumn(t('ملاحظات', 'Notes'), 36),
    ], rows: period.rows.map(row => [row.date, row.entry ? t(...kindLabels[row.entry.kind]) : t('تحويل داخلي', 'Internal transfer'),
      row.entry?.party ?? '', row.entry?.description ?? '', row.entry ? account(cashAccount(row.entry.method)) : `${account(row.transfer.from_account)} → ${account(row.transfer.from_account === 'cash' ? 'bank' : 'cash')}`,
      money(Math.max(row.amount, 0)), gbp(Math.max(row.amount, 0)), money(Math.max(-row.amount, 0)), gbp(Math.max(-row.amount, 0)),
      row.transfer ? money(Math.abs(row.cash)) : 0, money(row.balance), gbp(row.balance), row.entry?.notes ?? row.transfer?.notes ?? '']),
    }, { title: t('المستبعد من العهدة', 'Excluded from custody'), columns: [textColumn(t('التاريخ', 'Date'), 16), textColumn(t('الحركة', 'Movement')), textColumn(t('الجهة', 'Party')),
      textColumn(t('الوصف', 'Description'), 36), amountColumn('SAR'), amountColumn('GBP'), textColumn(t('ملاحظات', 'Notes'), 36)],
      rows: data.entries.filter(row => row.custody_excluded && !row.voided_at && (!from || row.date >= from) && (!to || row.date <= to))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
        .map(row => [row.date, t(...kindLabels[row.kind]), row.party, row.description, money(baseAmount(row)), gbp(baseAmount(row)), row.notes ?? '']),
    }],
  };
}
