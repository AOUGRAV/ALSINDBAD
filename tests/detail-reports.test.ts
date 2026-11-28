import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleData } from './fixtures';
import { cashAmount, preparePurchaseInvoice } from '../src/lib/domain';
import { containerReport, custodyReport } from '../src/lib/detail-reports';
import { containerCost } from '../src/lib/manifest';
import { custodyLedger, custodyPeriod } from '../src/lib/custody';

test('container exports contain only loaded quantities and their allocated cost, plus active linked expenses', () => {
  const data = sampleData(), container = data.containers[0];
  const invoice = preparePurchaseInvoice({ id: crypto.randomUUID(), date: '2026-11-24', created_at: '2026-11-24T12:00:00Z',
    party: 'Supplier', description: 'Invoice', category: 'Goods', currency: 'SAR', method: 'cash', rate: 1,
    invoice_number: '156916', invoice_vat_percent: 0, notes: '=1+1',
    invoice_items: [{ name: 'Oil', quantity: 20, unit: 'carton', unit_price: 22400 }],
  }, data);
  data.entries.push(invoice);
  data.invoice_loads.push({ entry_id: invoice.id, item_index: 0, container_id: container.id, quantity: 5, cost_sar: 112000 });
  const expense = data.entries.find(row => row.kind === 'expense')!;
  const before = cashAmount(expense, true);
  expense.container_id = container.id;
  expense.notes = 'Transport note';
  data.entries.push({ ...expense, id: crypto.randomUUID(), voided_at: invoice.created_at });
  const report = containerReport(data, container, 'ar');
  assert.deepEqual(report.tables[0].rows[0], ['156916', 'Supplier', 'Oil', 'Oil', 'carton', 5, 224, 1120, 224, '=1+1']);
  assert.equal(report.tables[1].rows.length, 1);
  assert.equal(report.tables[1].rows[0].at(-1), 'Transport note');
  assert.equal(report.summary.rows[2][1], containerCost(data, container).total / 100);
  assert.equal(cashAmount(expense, true), before);
});

test('container statements include both product names and exclude only selected lines and their allocated cost', () => {
  const data = sampleData(), container = data.containers[0];
  const invoice = preparePurchaseInvoice({ id: crypto.randomUUID(), date: '2026-11-28', created_at: '2026-11-28T12:00:00Z',
    party: 'Supplier', description: 'Invoice', category: 'Goods', currency: 'SAR', method: 'cash', rate: 1,
    invoice_number: 'BILINGUAL-1', invoice_items: [
      { name: 'زيت فاتيكا 200 مل', name_en: 'Vatika Oil 200 ml', quantity: 20, unit: 'كرتون', unit_price: 22400 },
      { name: 'شنطة موقد غاز', name_en: 'Gas Stove Bag', export_excluded: true, quantity: 3, unit: 'كرتون', unit_price: 10000 },
    ],
  }, data);
  data.entries.push(invoice);
  data.invoice_loads.push({ entry_id: invoice.id, item_index: 0, container_id: container.id, quantity: 5, cost_sar: 128800 },
    { entry_id: invoice.id, item_index: 1, container_id: container.id, quantity: 2, cost_sar: 23000 });
  const before = JSON.stringify(data), originalCost = containerCost(data, container);
  for (const lang of ['ar', 'en'] as const) {
    const report = containerReport(data, container, lang);
    assert.deepEqual(report.tables[0].rows[0].slice(2, 6), ['زيت فاتيكا 200 مل', 'Vatika Oil 200 ml', 'كرتون', 5]);
    assert.equal(report.tables[0].columns[3].direction, 'ltr');
    assert.equal(report.tables[0].rows.some(row => row.includes('Gas Stove Bag')), false);
    assert.equal(report.summary.rows[2][1], (originalCost.total - 23000) / 100);
    assert.equal(report.tables[0].rows.reduce((sum, row) => sum + Number(row[7]), 0), report.summary.rows[0][1]);
  }
  assert.equal(JSON.stringify(data), before);
  assert.equal(invoice.invoice_items?.[0].name_en, 'Vatika Oil 200 ml');
  assert.equal(invoice.invoice_items?.[1].export_excluded, true);
});

test('custody export reconciles opening and closing balances, preserves transfers, and separates excluded movements', () => {
  const data = sampleData();
  data.entries.forEach((entry, index) => {
    entry.date = index === 0 ? '2026-11-01' : '2026-11-24';
    entry.created_at = `${entry.date}T12:00:${String(index).padStart(2, '0')}Z`;
  });
  data.entries.at(-1)!.custody_excluded = true;
  data.cash_transfers = [{ id: crypto.randomUUID(), date: '2026-11-24', created_at: '2026-11-24T18:00:00Z',
    amount: 10000, currency: 'GBP', rate: 5, from_account: 'bank', notes: 'ATM withdrawal', revision: 1, voided_at: null }];
  const period = custodyPeriod(custodyLedger(data.entries, data.cash_transfers), '2026-11-24', '2026-11-24');
  const report = custodyReport(data, '2026-11-24', '2026-11-24', 'en');
  assert.equal(report.summary.rows[0][1], period.opening / 100);
  assert.equal(report.summary.rows[3][1], period.remaining / 100);
  const movements = report.tables[0].rows;
  assert.equal(movements.at(-1)![9], 500);
  assert.equal(movements.at(-1)![10], period.remaining / 100);
  assert.equal(movements.reduce((sum, row) => sum + Number(row[5]) - Number(row[7]), 0), (period.incoming - period.outgoing) / 100);
  assert.equal(report.tables[1].rows.length, 1);
  assert.throws(() => custodyReport(data, '2026-12-01', '2026-11-01', 'ar'), /Invalid date range/);
});
