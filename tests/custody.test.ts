import assert from 'node:assert/strict';
import { test } from 'node:test';
import { custodyLedger, custodyPeriod } from '../src/lib/custody';
import { entrySchema, type CashTransfer, type Entry } from '../src/lib/domain';
import { sampleData } from './fixtures';

const template = sampleData().entries[0];
const entry = (id: string, amount: number, changes: Partial<Entry> = {}): Entry => ({
  ...template, id, date: '2026-11-01', created_at: id, amount, paid: amount, method: 'cash', ...changes,
});

test('new owner funds accumulate and only actual payments leave the running balance', () => {
  const entries = [
    entry('1', 10_000_000),
    entry('2', 3_000_000, { kind: 'purchase', paid: 1_000_000 }),
    entry('3', 2_000_000, { kind: 'repay', settles_id: '2' }),
    entry('4', 500_000, { kind: 'expense', method: 'card' }),
    entry('5', 1_000_000, { date: '2026-11-24', method: 'bank' }),
    entry('6', 900_000, { kind: 'borrow', opening: true }),
    entry('7', 800_000, { kind: 'expense', voided_at: '2026-11-24T00:00:00Z' }),
  ];
  const all = custodyPeriod(custodyLedger(entries));
  assert.equal(all.incoming, 11_000_000);
  assert.equal(all.outgoing, 3_500_000);
  assert.equal(all.remaining, 7_500_000);
  assert.equal(all.cash, 7_000_000);
  assert.equal(all.bank, 500_000);
  const later = custodyPeriod(custodyLedger(entries), '2026-11-20', '2026-11-24');
  assert.equal(later.opening, 6_500_000);
  assert.equal(later.remaining, 7_500_000);
  assert.equal(later.incoming, 1_000_000);
});

test('cash-to-bank transfers affect account balances without creating an expense', () => {
  const transfer: CashTransfer = { id: '2', date: '2026-11-02', created_at: '2', amount: 10000, currency: 'USD',
    rate: 3.75, from_account: 'cash', notes: '', revision: 1, voided_at: null };
  const period = custodyPeriod(custodyLedger([entry('1', 100_000)], [transfer]));
  assert.equal(period.remaining, 100_000);
  assert.equal(period.cash, 62_500);
  assert.equal(period.bank, 37_500);
  assert.equal(period.outgoing, 0);
  assert.equal(custodyPeriod(custodyLedger([entry('1', 100_000)], [{ ...transfer, voided_at: '2026-11-24' }])).cash, 100_000);
});

test('optional notes accept existing records and enforce the length limit', () => {
  assert.equal(entrySchema.parse(template).notes, undefined);
  assert.equal(entrySchema.parse({ ...template, notes: '  فاتورة تخص الشحنة الثانية\nملاحظة إضافية  ' }).notes,
    'فاتورة تخص الشحنة الثانية\nملاحظة إضافية');
  assert.equal(entrySchema.safeParse({ ...template, notes: 'x'.repeat(2001) }).success, false);
});
