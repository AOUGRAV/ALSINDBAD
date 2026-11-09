import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { cashAmount, emptyData, preparePurchaseInvoice, validateEntry, type Container } from '../src/lib/domain';
import { availableInvoiceItems, containerCost } from '../src/lib/manifest';

const fields = {
  id: randomUUID(), date: '2026-11-09', created_at: '2026-11-09T12:00:00Z',
  party: 'Seller', description: 'Purchase', category: 'Merchandise',
  currency: 'SAR' as const, method: 'cash' as const, rate: 1,
};

test('invoice quantities available to a container exclude other allocations and include its own', () => {
  const data = emptyData();
  const invoice = preparePurchaseInvoice({
    ...fields, invoice_number: 'QA-100',
    invoice_items: [{ name: 'Oil', unit: 'carton', quantity: 1, unit_price: 1000 },
      { name: 'Soap', unit: 'box', quantity: 2, unit_price: 1000 }],
  }, data);
  data.entries.push(invoice);
  const own = randomUUID(), other = randomUUID();
  data.invoice_loads.push(
    { container_id: own, entry_id: invoice.id, item_index: 0, quantity: 0.6, cost_sar: 690 },
    { container_id: other, entry_id: invoice.id, item_index: 0, quantity: 0.3, cost_sar: 345 },
    { container_id: other, entry_id: invoice.id, item_index: 1, quantity: 2, cost_sar: 2300 },
  );
  assert.deepEqual(availableInvoiceItems(data, own)[0].items.map(item => [item.index, item.available, item.assigned]), [[0, 0.7, 0.6]]);
  assert.equal(availableInvoiceItems(data)[0].items[0].available, 0.1);
});

test('a categorized personal expense can be recorded without a payee', () => {
  const expense = {
    ...fields, kind: 'expense', scope: 'personal', party: '', category: 'Vehicle rental',
    description: 'Two-day rental', amount: 20000, paid: 20000, product_id: null, quantity: 0,
    settles_id: null, container_id: null, receipt_path: null,
  };
  assert.equal(cashAmount(validateEntry(expense, emptyData())), -20000);
  assert.throws(() => validateEntry({ ...expense, kind: 'funding' }, emptyData()), /Party is required/);
});

test('container totals convert the sum of loaded products and expenses at the workspace GBP rate', () => {
  const data = emptyData();
  const container: Container = { id: randomUUID(), name: 'QA-101', destination: 'UK', booking: '',
    status: 'shipped', created_at: fields.created_at, manifest_revision: 1 };
  data.containers.push(container);
  assert.equal(containerCost(data, container).gbp, 0);
  data.invoice_loads.push({ container_id: container.id, entry_id: randomUUID(), item_index: 0, quantity: 1, cost_sar: 20000 });
  const expense = validateEntry({ ...fields, kind: 'expense', scope: 'business', party: '', amount: 3500, paid: 3500,
    product_id: null, quantity: 0, settles_id: null, container_id: container.id, receipt_path: null }, data);
  data.entries.push(expense, { ...expense, id: randomUUID(), voided_at: fields.created_at });
  const total = containerCost(data, container);
  assert.equal(total.total, 23500);
  assert.equal(total.gbp, 4700);
});
