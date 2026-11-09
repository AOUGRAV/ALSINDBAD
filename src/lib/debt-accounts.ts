import { debtPrincipal, debtSide, type Entry } from './domain';

export type MovementDirection = 'take' | 'give';
export type DebtMovement = Pick<Entry, 'id' | 'party' | 'date' | 'currency' | 'scope' | 'amount' | 'rate' | 'method' | 'description' | 'category' | 'opening'> &
  { direction: MovementDirection; separate: boolean };
export type MovementAllocation = { debt_id: string; amount: number };
type Balance = Pick<Entry, 'currency' | 'scope' | 'amount'>;

export const debtAccountKey = (party: string) => party.trim().toLowerCase();
export const movementDirection = (entry: Entry): MovementDirection => entry.kind === 'borrow' || entry.kind === 'collect' ? 'take' : 'give';

function paymentTotals(entries: Entry[]) {
  const amounts = new Map<string, number>();
  for (const entry of entries) if (!entry.voided_at && entry.settles_id) {
    amounts.set(entry.settles_id, (amounts.get(entry.settles_id) ?? 0) + entry.amount);
  }
  return amounts;
}

export function debtAccounts(entries: Entry[]) {
  const payments = paymentTotals(entries);
  const accounts = new Map<string, { key: string; name: string; entries: Entry[]; balances: Map<string, Balance>; open: { entry: Entry; amount: number }[] }>();
  for (const entry of entries) {
    const principal = debtPrincipal(entry);
    if (entry.voided_at || (!principal && !entry.settles_id)) continue;
    const key = debtAccountKey(entry.party);
    const account = accounts.get(key) ?? { key, name: entry.party, entries: [], balances: new Map<string, Balance>(), open: [] };
    account.entries.push(entry);
    if (principal > 0) {
      const { currency, scope } = entry;
      const balanceKey = currency + '/' + scope;
      const outstanding = principal - (payments.get(entry.id) ?? 0);
      if (outstanding > 0) account.open.push({ entry, amount: outstanding });
      const sign = debtSide(entry) === 'receivable' ? 1 : -1;
      account.balances.set(balanceKey, { currency, scope, amount: (account.balances.get(balanceKey)?.amount ?? 0) + sign * outstanding });
    }
    accounts.set(key, account);
  }
  return [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type PlanInput = Pick<DebtMovement, 'party' | 'currency' | 'scope' | 'date' | 'direction' | 'amount' | 'separate' | 'opening'>;
export function planDebtMovement(entries: Entry[], movement: PlanInput) {
  const allocations: MovementAllocation[] = [];
  let remaining = movement.amount;
  if (!Number.isSafeInteger(remaining) || remaining <= 0 || movement.separate || movement.opening) return { allocations, remaining };
  const key = debtAccountKey(movement.party);
  const opposite = movement.direction === 'take' ? 'receivable' : 'payable';
  const paid = paymentTotals(entries);
  const candidates = entries.filter(e => !e.voided_at && e.currency === movement.currency && e.scope === movement.scope &&
    e.date <= movement.date && debtAccountKey(e.party) === key && debtPrincipal(e) > 0 && debtSide(e) === opposite)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id.localeCompare(b.id)));
  for (const debt of candidates) {
    const amount = Math.min(remaining, debtPrincipal(debt) - (paid.get(debt.id) ?? 0));
    if (amount <= 0) continue;
    allocations.push({ debt_id: debt.id, amount });
    remaining -= amount;
    if (remaining === 0) break;
  }
  return { allocations, remaining };
}
