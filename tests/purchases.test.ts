import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { cashAmount, debtBalance, emptyData, preparePurchaseInvoice, validateEntry } from '../src/lib/domain';
import { invoiceLineTotal, invoiceTotals } from '../src/lib/purchases';

const item = { name: 'Test product', quantity: 8, unit: 'Carton', unit_price: 12500 };

test('invoice totals use line rounding and apply 15% VAT to the subtotal', () => {
  const fractional = { ...item, quantity: 0.5, unit_price: 19 };
  assert.equal(invoiceLineTotal(fractional), 10);
  assert.deepEqual(invoiceTotals([item, fractional]), { subtotal: 100010, vat: 15002, total: 115012 });
  assert.equal(invoiceLineTotal({ ...item, quantity: 1.0001 }), null);
  assert.equal(invoiceTotals([{ ...item, quantity: 100000000 }]), null);
});

test('purchase invoices work without stock and only the unpaid part is a debt', () => {
  const data = emptyData();
  const draft = {
    id: randomUUID(), created_at: '2026-11-08T12:00:00Z', date: '2026-11-08',
    party: 'Test seller', category: 'Purchases', description: 'Purchase invoice TEST-1',
    currency: 'SAR' as const, rate: 1, method: 'cash' as const,
    invoice_number: 'TEST-1', invoice_items: [item],
  };
  const original = { ...preparePurchaseInvoice(draft, data), receipt_path: 'test.pdf' };
  assert.equal(original.amount, 115000);
  assert.equal(original.paid, 115000);
  assert.equal(original.product_id, null);
  assert.equal(debtBalance(original, []), 0);

  data.entries.push(original);
  const edited = preparePurchaseInvoice({ ...draft, invoice_number: 'TEST-2',
    invoice_items: [{ ...item, quantity: 4 }], paid: 30000 }, data, original);
  assert.equal(edited.id, original.id);
  assert.equal(edited.receipt_path, original.receipt_path);
  assert.equal(edited.invoice_number, 'TEST-2');
  assert.equal(edited.amount, 57500);
  assert.equal(cashAmount(edited), -30000);
  assert.equal(debtBalance(edited, []), 27500);
  assert.throws(() => validateEntry({ ...edited, amount: 57501 }, data, original), /Total does not match/);
});
