import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { baseAmount, debtBalance, inventory, summary, toSar, validateEntry, validateLoad, type Entry, type Load } from '../src/lib/domain';
import { demoData } from '../src/lib/demo';

test('temporary financing increases available cash and payables together', () => {
  const debt = demoData().entries.find(entry => entry.kind === 'borrow')!;
  const totals = summary([debt]);
  assert.equal(debt.currency, 'USD');
  assert.equal(totals.cash, 3_750_000);
  assert.equal(totals.payable, 3_750_000);
  assert.equal(totals.expenses, 0);
});

test('a purchase adds its full cost to stock, with only the paid portion leaving cash', () => {
  const data = demoData();
  const purchase = data.entries.find(entry => entry.kind === 'purchase')!;
  const totals = summary([purchase]);
  assert.equal(totals.cash, -2_000_000);
  assert.equal(totals.purchases, 2_880_000);
  assert.equal(totals.payable, 880_000);
  assert.equal(inventory(data, purchase.product_id!).remaining, 40);
});

test('partial repayments reduce the original principal while recording cash at the new rate', () => {
  const data = demoData();
  const debt = data.entries.find(entry => entry.kind === 'borrow')!;
  const payment: Entry = { ...debt, id: randomUUID(), kind: 'repay', settles_id: debt.id, amount: 250_000, paid: 250_000, rate: 3.8 };
  assert.deepEqual(validateEntry(payment, data), payment);
  assert.equal(debtBalance(debt, [debt, payment]), 750_000);
  assert.equal(baseAmount(payment), 950_000);
  assert.equal(summary([debt, payment]).payable, 2_812_500);
  assert.equal(summary([debt, payment]).cash, 2_800_000);
  assert.throws(() => validateEntry({ ...payment, currency: 'GBP' }, data), /debt currency/);
  assert.throws(() => validateEntry({ ...payment, amount: 1_000_001, paid: 1_000_001 }, data), /exceeds balance/);
});

test('paying the remainder of a supplier purchase clears the payable without duplicating the purchase', () => {
  const data = demoData();
  const purchase = data.entries.find(entry => entry.kind === 'purchase')!;
  const remainder = purchase.amount - purchase.paid;
  const repayment: Entry = { ...purchase, id: randomUUID(), kind: 'repay', amount: remainder, paid: remainder,
    settles_id: purchase.id, product_id: null, quantity: 0 };
  validateEntry(repayment, data);
  assert.equal(debtBalance(purchase, [purchase, repayment]), 0);
  assert.equal(summary([purchase, repayment]).purchases, purchase.amount);
  assert.equal(summary([purchase, repayment]).cash, -purchase.amount);
});

test('only available stock can be loaded and shipped containers stay closed', () => {
  const data = demoData();
  const container = data.containers[0];
  const load: Load = { id: randomUUID(), product_id: data.products[0].id, container_id: container.id, quantity: 40, created_at: container.created_at };
  assert.deepEqual(validateLoad(load, data), load);
  assert.throws(() => validateLoad({ ...load, quantity: 41 }, data), /Insufficient stock/);
  container.status = 'shipped';
  assert.throws(() => validateLoad(load, data), /not open/);
});

test('currency conversions round to the nearest halala using the recorded rate', () => {
  assert.equal(toSar(1, 1.499999), 1);
  assert.equal(toSar(1, 1.5), 2);
  assert.equal(toSar(100_000_000_000, 10_000), 1_000_000_000_000_000);
});
