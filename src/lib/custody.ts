import { cashAmount, toSar, type CashTransfer, type Entry } from './domain';

export type CashAccount = 'cash' | 'bank';
export const cashAccount = (method: Entry['method']): CashAccount => method === 'cash' ? 'cash' : 'bank';
export type CustodyRow = {
  id: string; date: string; created_at: string; amount: number; balance: number; cash: number; bank: number;
} & ({ entry: Entry; transfer?: never } | { transfer: CashTransfer; entry?: never });

export function custodyLedger(entries: Entry[], transfers: CashTransfer[] = []) {
  const rows: CustodyRow[] = [];
  for (const entry of entries) {
    const amount = cashAmount(entry, true);
    if (!amount) continue;
    const account = cashAccount(entry.method);
    rows.push({ id: entry.id, date: entry.date, created_at: entry.created_at, entry, amount, balance: 0,
      cash: account === 'cash' ? amount : 0, bank: account === 'bank' ? amount : 0 });
  }
  for (const transfer of transfers) {
    if (transfer.voided_at) continue;
    const amount = toSar(transfer.amount, transfer.rate);
    const cash = transfer.from_account === 'cash' ? -amount : amount;
    rows.push({ id: transfer.id, date: transfer.date, created_at: transfer.created_at, transfer,
      amount: 0, balance: 0, cash, bank: -cash });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  let balance = 0;
  for (const row of rows) {
    balance += row.amount;
    row.balance = balance;
  }
  return rows;
}

export function custodyPeriod(rows: CustodyRow[], from = '', to = '') {
  const eligible = rows.filter(row => !to || row.date <= to);
  const period = eligible.filter(row => !from || row.date >= from);
  const opening = eligible.filter(row => from && row.date < from).reduce((sum, row) => sum + row.amount, 0);
  const incoming = period.reduce((sum, row) => sum + Math.max(0, row.amount), 0);
  const outgoing = period.reduce((sum, row) => sum + Math.max(0, -row.amount), 0);
  const cash = eligible.reduce((sum, row) => sum + row.cash, 0);
  const bank = eligible.reduce((sum, row) => sum + row.bank, 0);
  return { rows: period, opening, incoming, outgoing, remaining: opening + incoming - outgoing, cash, bank };
}
