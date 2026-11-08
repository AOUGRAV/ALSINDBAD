import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { baseAmount, debtBalance, debtSide, emptyData, inventory, prepareDebtEntry, summary, toSar, validateEntry, validateLoad, type Entry, type LoadDraft } from '../src/lib/domain';
import { sampleData } from './fixtures';

test('borrowing, lending part of it, and paying an expense produce two debts and the remaining cash', () => {
  const data = emptyData();
  const fields = {
    created_at: '2026-11-08T12:00:00Z', date: '2026-11-08', rate: 1,
    method: 'bank' as const, category: 'Debts', scope: 'business' as const,
    currency: 'SAR' as const, opening: false,
  };
  const payable = prepareDebtEntry({ ...fields, id: randomUUID(), direction: 'payable',
    party: 'Lender', description: 'Borrowed', amount: 100_000 }, data);
  const receivable = prepareDebtEntry({ ...fields, id: randomUUID(), direction: 'receivable',
    party: 'Borrower', description: 'Lent', amount: 35_000 }, data);
  const expense = validateEntry({ ...receivable, id: randomUUID(), kind: 'expense',
    party: 'Vendor', description: 'Invoice', amount: 22_500, paid: 22_500 }, data);
  const entries = [payable, receivable, expense];
  assert.equal(debtSide(payable), 'payable');
  assert.equal(debtSide(receivable), 'receivable');
  assert.deepEqual(summary(entries), { cash: 42_500, purchases: 0, expenses: 22_500, payable: 100_000, receivable: 35_000 });
  assert.equal(summary([{ ...payable, voided_at: fields.created_at }, receivable, expense]).payable, 0);
});

test('a payment created from a debt uses its own direction, party and original currency', () => {
  const data = sampleData();
  const debt = data.entries.find(entry => entry.kind === 'borrow')!;
  const payment = prepareDebtEntry({ id: randomUUID(), created_at: debt.created_at, date: debt.date,
    debt, amount: 25_000, rate: debt.rate, method: 'bank', description: 'Payment' }, data);
  assert.equal(payment.kind, 'repay');
  assert.equal(payment.currency, debt.currency);
  assert.equal(payment.party, debt.party);
  assert.equal(payment.settles_id, debt.id);
  assert.equal(debtBalance(debt, [...data.entries, payment]), debt.amount - payment.amount);
});

test('temporary financing increases available cash and payables together', () => {
  const debt = sampleData().entries.find(entry => entry.kind === 'borrow')!;
  const totals = summary([debt]);
  assert.equal(debt.currency, 'USD');
  assert.equal(totals.cash, 3_750_000);
  assert.equal(totals.payable, 3_750_000);
  assert.equal(totals.expenses, 0);
});

test('a purchase adds its full cost to stock, with only the paid portion leaving cash', () => {
  const data = sampleData();
  const purchase = data.entries.find(entry => entry.kind === 'purchase')!;
  const totals = summary([purchase]);
  assert.equal(totals.cash, -2_000_000);
  assert.equal(totals.purchases, 2_880_000);
  assert.equal(totals.payable, 880_000);
  assert.equal(inventory(data, purchase.product_id!).remaining, 40);
});

test('partial repayments reduce the original principal while recording cash at the new rate', () => {
  const data = sampleData();
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
  const data = sampleData();
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
  const data = sampleData();
  const container = data.containers[0];
  const load: LoadDraft = { id: randomUUID(), product_id: data.products[0].id, container_id: container.id, quantity: 40, created_at: container.created_at };
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

test('opening debt is collectible without creating an opening cash movement', () => {
  const data = sampleData();
  const debt = { ...data.entries.find(entry => entry.kind === 'lend')!, opening: true };
  assert.equal(summary([debt]).cash, 0);
  assert.equal(summary([debt]).receivable, debt.amount);
});

test('voided payments restore the debt balance and leave cash totals', () => {
  const data = sampleData();
  const debt = data.entries.find(entry => entry.kind === 'borrow')!;
  const payment: Entry = { ...debt, id: randomUUID(), kind: 'repay', settles_id: debt.id,
    amount: 250_000, paid: 250_000, voided_at: '2026-11-07T18:00:00Z', revision: 2 };
  assert.equal(debtBalance(debt, [debt, payment]), debt.amount);
  assert.deepEqual(summary([debt, payment]), summary([debt]));
  assert.throws(() => validateEntry({ ...payment, id: randomUUID(), voided_at: null }, {
    ...data, entries: [{ ...debt, voided_at: payment.voided_at }],
  }), /Debt not found/);
});

test('correcting a repayment excludes its old amount from the available balance', () => {
  const data = sampleData();
  const debt = data.entries.find(entry => entry.kind === 'borrow')!;
  const payment: Entry = { ...debt, id: randomUUID(), kind: 'repay', settles_id: debt.id, amount: 750_000, paid: 750_000 };
  data.entries.push(payment);
  const correction = { ...payment, amount: 1_000_000, paid: 1_000_000 };
  assert.equal(validateEntry(correction, data, payment).amount, debt.amount);
});
