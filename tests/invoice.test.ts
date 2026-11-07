import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractInvoiceFields } from '../src/lib/invoice';

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
