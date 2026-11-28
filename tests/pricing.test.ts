import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePricing, copyContainerForPricing, copyInvoiceForPricing, type PricingDocument } from '../src/lib/pricing';
import { baseAmount, emptyData, preparePurchaseInvoice, type Container, type Entry } from '../src/lib/domain';

test('pricing copies shipped items, even when excluded from the manifest export, and groups repeat purchases by their actual cost', () => {
  const data = emptyData();
  const container = {id: 'container'} as Container;
  const item = {name: 'زيت', name_en: 'Oil', unit: 'Carton', quantity: 40, unit_price: 22000};
  data.entries = [
    {id: 'a', invoice_items: [item, {...item, name: 'شنطة', name_en: 'Gas-stove bag', export_excluded: true}]},
    {id: 'b', invoice_items: [item]},
    {id: 'uk', kind: 'expense', container_id: 'container', date: '2026-11-28', currency: 'GBP', amount: 12000, rate: 5.4, description: 'UK transport'},
  ] as Entry[];
  data.invoice_loads = [
    {container_id: 'container', entry_id: 'a', item_index: 0, quantity: 20, cost_sar: 500000},
    {container_id: 'container', entry_id: 'b', item_index: 0, quantity: 30, cost_sar: 765000},
    {container_id: 'container', entry_id: 'a', item_index: 1, quantity: 1, cost_sar: 20000},
  ];
  const before = structuredClone(data);
  const document = copyContainerForPricing(data, container);
  assert.deepEqual(document.items.map(({english, quantity, purchase}) => ({english, quantity, purchase})), [
    {english: 'Oil', quantity: 50, purchase: 50.6}, {english: 'Gas-stove bag', quantity: 1, purchase: 40},
  ]);
  assert.equal(document.expenses[0].amount, 120);
  document.items.pop();
  assert.deepEqual(data, before);
});

test('quantity and value both reconcile expenses and report profit only for priced rows in their chosen selling units', () => {
  const document: PricingDocument = {
    allocation: 'quantity',
    items: [
      {id: 'a', name: '', english: 'Pepper', unit: 'Carton', quantity: 10, purchase: 20, pack: 5, sale: 10},
      {id: 'b', name: '', english: 'Oil', unit: 'Carton', quantity: 10, purchase: 80, pack: 1, sale: null},
    ],
    expenses: [{id: 'expense', label: 'Shipping', stage: 'Shipping', amount: 1000, currency: 'SAR'}],
  };
  const quantity = calculatePricing(document);
  assert.deepEqual(quantity.rows.map(row => row.share), [100, 100]);
  assert.equal(quantity.rows[0].landed, 6);
  assert.equal(quantity.revenue, 500);
  assert.equal(quantity.profit, 200);
  const value = calculatePricing({...document, allocation: 'value'});
  assert.deepEqual(value.rows.map(row => row.share), [40, 160]);
  assert.equal(value.cost, 1200);
  assert.equal(value.priced, 1);
  assert.equal(value.rows[1].profit, null);
  assert.equal(calculatePricing({...document, items: []}).unallocated, 200);
});

test('a detached purchase invoice can be copied directly, with its VAT and exchange rounding and no duplicate copied lines', () => {
  const data = emptyData();
  const invoice = preparePurchaseInvoice({id: crypto.randomUUID(), created_at: '2026-11-05T12:00:00Z', date: '2026-11-05',
    party: 'Supplier', description: 'Purchase invoice', category: 'Purchases', currency: 'USD', rate: 3.75,
    method: 'bank', paid: 0, invoice_number: 'QA-DETACHED', invoice_vat_percent: 15, invoice_items: Array.from({length: 57}, (_, index) => ({
      name: `منتج ${index + 1}`, name_en: `Product ${index + 1}`, quantity: index + 1, unit: 'كرتون', unit_price: 101 + index,
    }))}, data);
  const before = structuredClone(invoice);
  const items = copyInvoiceForPricing(invoice, []);
  assert.equal(items.length, 57);
  assert.equal(items.at(-1)?.english, 'Product 57');
  assert.equal(Math.round(calculatePricing({allocation:'quantity',items,expenses:[]}).goods * 500), baseAmount(invoice));
  assert.equal(copyInvoiceForPricing(invoice, items).length, 0);
  assert.deepEqual(copyInvoiceForPricing(invoice, items.slice(0,-1)).map(item => item.english), ['Product 57']);
  assert.deepEqual(invoice, before);
  assert.equal(data.invoice_loads.length, 0);
});
