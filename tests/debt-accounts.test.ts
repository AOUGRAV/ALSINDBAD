import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { debtAccounts, planDebtMovement } from '../src/lib/debt-accounts';
import { emptyData, prepareDebtEntry } from '../src/lib/domain';

const fields = {
  party: 'Adel', date: '2026-11-09', created_at: '2026-11-09T12:00:00Z', scope: 'business' as const,
  currency: 'SAR' as const, rate: 1, method: 'cash' as const, opening: false, description: 'Debt', category: 'Debts',
};

test('one outgoing movement settles the oldest loans in the same account, currency and scope', () => {
  const data = emptyData();
  const first = prepareDebtEntry({ ...fields, id: randomUUID(), date: '2026-11-07', amount: 10000, direction: 'payable' }, data);
  const second = prepareDebtEntry({ ...fields, id: randomUUID(), party: 'ADEL', date: '2026-11-08', amount: 5000, direction: 'payable' }, data);
  const personal = prepareDebtEntry({ ...fields, id: randomUUID(), scope: 'personal', amount: 9999, direction: 'payable' }, data);
  const existingPayment = prepareDebtEntry({ ...fields, id: randomUUID(), debt: first, amount: 2500 }, { ...data, entries: [first] });
  const entries = [second, personal, existingPayment, first];
  const movement = { ...fields, direction: 'give' as const, amount: 8500, separate: false };
  assert.deepEqual(planDebtMovement(entries, movement), {
    allocations: [{ debt_id: first.id, amount: 7500 }, { debt_id: second.id, amount: 1000 }], remaining: 0,
  });
  assert.equal(planDebtMovement(entries, { ...movement, amount: 15000 }).remaining, 2500);
  assert.deepEqual(planDebtMovement(entries, { ...movement, separate: true }), { allocations: [], remaining: 8500 });
  const [account] = debtAccounts(entries);
  assert.equal(account.entries.length, 4);
  assert.deepEqual([...account.balances.values()].map(balance => balance.amount), [-12500, -9999]);
});
