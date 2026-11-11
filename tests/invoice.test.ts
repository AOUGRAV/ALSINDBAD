import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractInvoiceFields, extractInvoiceItems, extractScannedInvoiceTotal, readSaudiInvoiceQr } from '../src/lib/invoice';
import { readScannedTable, type OcrWord } from '../src/lib/scanned-table';

test('extracts an Arabic invoice without confusing the tax or amount due with the invoice total', () => {
  const invoice = extractInvoiceFields([
    'المورد: مؤسسة جدة', 'رقم الفاتورة: INV-١٢٣', 'تاريخ الفاتورة: ٠٧/١١/٢٠٢٦',
    'الإجمالي قبل الضريبة: ١٬٠٠٠٫٠٠', 'الضريبة: ١٥٠٫٠٠', 'الإجمالي شامل الضريبة: ١٬١٥٠٫٠٠ SAR', 'المبلغ المستحق: ٩٠٠٫٠٠',
  ].join('\n'));
  assert.deepEqual(invoice, { total: '1150.00', date: '2026-11-07', currency: 'SAR', number: 'INV-123', supplier: 'مؤسسة جدة' });
});

test('reads English invoice totals with a currency, and ignores due dates', () => {
  const invoice = extractInvoiceFields('Supplier: Jeddah LLC\nInvoice Date: 2026-11-07\nDue Date: 2026-12-07\nGrand Total: £ 2,139.05\nBalance due £ 1000');
  assert.equal(invoice.total, '2139.05');
  assert.equal(invoice.currency, 'GBP');
  assert.equal(invoice.date, '2026-11-07');
});

test('does not suggest conflicting totals, ambiguous dollars, invalid dates, or a partial balance as the total', () => {
  assert.equal(extractInvoiceFields('Grand total: 30 USD\nGrand total: 35 USD').total, undefined);
  assert.equal(extractInvoiceFields('Grand total: $30').currency, undefined);
  assert.equal(extractInvoiceFields('Invoice date: 31/02/2026').date, undefined);
  assert.equal(extractInvoiceFields('Balance due: 20 USD\nTotal due: 20 USD').total, undefined);
});

test('finds a company letterhead and imports rows only when quantities and prices match their totals', () => {
  const text = [
    'COASTAL GOODS TRADING COMPANY شركة السلع الساحلية',
    'Customer: Port Storage LLC',
    'Invoice No.: CO-41',
    'Item Description | Qty | Unit | U. Price | Line Total',
    'Cooking oil | 20 | carton | 12.50 | 250.00',
    'Ground coffee | 2.5 | kg | 14.00 | 35.00',
    'Grand total: SAR 327.75',
  ].join('\n');
  assert.equal(extractInvoiceFields(text).supplier, 'COASTAL GOODS TRADING COMPANY');
  assert.deepEqual(extractInvoiceItems(text), [
    { name: 'Cooking oil', quantity: 20, unit: 'carton', unit_price: 1250 },
    { name: 'Ground coffee', quantity: 2.5, unit: 'kg', unit_price: 1400 },
  ]);
  assert.deepEqual(extractInvoiceItems(text.replace('35.00', '36.00')), []);
  assert.deepEqual(extractInvoiceItems(text.replace('Ground coffee | 2.5', 'Unreadable row')), []);
});

test('uses a scanned due total only with a corroborating tax summary', () => {
  const labels = 'Total Taxable Amount (Excluding VAT)\nTotal VAT Amount\nTotal Amount Due';
  assert.equal(extractScannedInvoiceTotal('1,500.00\n225.00\n1,725. 00', labels), '1725.00');
  assert.equal(extractScannedInvoiceTotal('1,500.00\n225.00\n1,000.00', labels), undefined);
  assert.equal(extractScannedInvoiceTotal('1,500.00\n225.00\n1,725.00', labels + '\nBalance due'), undefined);
});

test('validates the first five fields of a Saudi invoice QR code', () => {
  const fields = ['متجر الساحل', '300000000000003', '2026-11-07T10:30:00+03:00', '115.00', '15.00'];
  const payload = Buffer.concat(fields.map((field, index) => {
    const bytes = Buffer.from(field);
    return Buffer.concat([Buffer.from([index + 1, bytes.length]), bytes]);
  })).toString('base64');
  assert.deepEqual(readSaudiInvoiceQr(payload), { supplier: 'متجر الساحل', date: '2026-11-07', total: '115.00', currency: 'SAR' });
  assert.deepEqual(readSaudiInvoiceQr('https://example.test/invoice'), {});
  assert.deepEqual(readSaudiInvoiceQr(payload.slice(0, -8)), {});
});

test('reads scanned columns by row and reconciles the unit price with the printed amount', async () => {
  const width = 900;
  const height = 600;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 240; y < 400; y++) {
    for (const x of [90, 340, 410, 480, 550, 610, 710, 765, 820, 890]) data[(y * width + x) * 4] = 255;
  }
  const word = (text: string, left: number, top: number, line = String(top)): OcrWord =>
    ({ text, line, left, top, width: 24, height: 12 });
  const words = [
    word('Description', 150, 210), word('Qty', 365, 210),
    word('Total', 630, 210), word('Price', 655, 210),
    word('20', 365, 260), word('10', 365, 306),
  ];
  const columns = {
    name: [word('Olive oil', 105, 253), word('Rice', 105, 299)],
    quantity: [word('20', 365, 260), word('16', 365, 306)],
    'quantity-alt': [word('20', 365, 260), word('10', 365, 306)],
    'quantity-contrast': [],
    unit: [word('carton', 420, 260), word('bag', 420, 306)],
    price: [word('12.50', 490, 260), word('7.25', 490, 306)],
    net: [word('250.00', 630, 260), word('72.50', 630, 306)],
    vat: [], gross: [],
  };
  assert.deepEqual(await readScannedTable({ width, height, data, colorSpace: 'srgb' }, words, async (_, kind) => columns[kind]), [
    { name: 'Olive oil', unit: 'carton', quantity: 20, unit_price: 1250 },
    { name: 'Rice', unit: 'bag', quantity: 10, unit_price: 725 },
  ]);
});
