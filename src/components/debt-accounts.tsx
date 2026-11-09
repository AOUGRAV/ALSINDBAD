'use client';

import { useState } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Download, Pencil, Trash2 } from 'lucide-react';
import { debtAccounts, debtAccountKey, movementDirection, type MovementDirection } from '@/lib/debt-accounts';
import { debtPrincipal, debtSide, type DebtDirection, type Entry, type Lang } from '@/lib/domain';
import { MoneyAmount } from './money-amount';
import { translate, type Editor } from './forms';
import { Empty } from './views';

type Account = ReturnType<typeof debtAccounts>[number];

function AccountBalance({ account, lang }: { account: Account; lang: Lang }) {
  const t = translate(lang);
  const balances = [...account.balances.values()].filter(balance => balance.amount !== 0);
  const multipleScopes = new Set(balances.map(balance => balance.scope)).size > 1;
  if (!balances.length) return <span className="tag">{t('الرصيد صفر', 'Zero balance')}</span>;
  return <div className="account-balances">{balances.map(balance => <div className="split-line" key={balance.currency + balance.scope}>
    <span>{balance.amount > 0 ? t('لنا', 'Owed to us') : t('علينا', 'We owe')}
      {multipleScopes && <> · {balance.scope === 'personal' ? t('شخصي', 'Personal') : t('تجاري', 'Business')}</>}</span>
    <strong><MoneyAmount amount={Math.abs(balance.amount)} currency={balance.currency} lang={lang} /></strong>
  </div>)}</div>;
}

function AccountActions({ row, account, lang, edit, onReceipt }: {
  row: Entry; account: Account; lang: Lang; edit: (editor: Editor) => void; onReceipt: (path: string) => void;
}) {
  const t = translate(lang);
  const debt = row.settles_id ? account.entries.find(entry => entry.id === row.settles_id) : undefined;
  const purchase = row.kind === 'purchase';
  const hasPayments = !debt && account.entries.some(entry => entry.settles_id === row.id);
  const target: Editor = debt ? { type: 'settlement', debt, original: row }
    : purchase ? { type: row.invoice_items ? 'purchase' : 'entry', original: row } : { type: 'debt', original: row };
  return <div className="actions account-row-actions">
    {row.receipt_path && <button className="icon-btn" aria-label={t('تنزيل المرفق', 'Download attachment')} onClick={() => onReceipt(row.receipt_path!)}><Download size={16} /></button>}
    <button className="btn secondary" onClick={() => edit(target)}><Pencil size={15} />{t('تعديل', 'Edit')}</button>
    {!purchase && <button className="btn secondary debt-delete" disabled={hasPayments}
      onClick={() => edit({ type: 'void', original: row, debtItem: debt ? 'payment' : 'debt' })}><Trash2 size={15} />{t('حذف', 'Delete')}</button>}
    {!purchase && hasPayments && <small>{t('احذف الدفعات أولًا.', 'Delete the payments first.')}</small>}
  </div>;
}

export function DebtAccounts({ entries, lang, selected, select, edit, onReceipt }: {
  entries: Entry[]; lang: Lang; selected: string | null; select: (key: string | null) => void;
  edit: (editor: Editor) => void; onReceipt: (path: string) => void;
}) {
  const t = translate(lang);
  const [side, setSide] = useState<'all' | DebtDirection>('all');
  const [query, setQuery] = useState('');
  const accounts = debtAccounts(entries);
  const account = accounts.find(item => item.key === selected);

  if (!account) {
    const filters = [['all', t('الكل', 'All')], ['receivable', t('لنا', 'Owed to us')], ['payable', t('علينا', 'We owe')]] as const;
    const visible = accounts.filter(item => item.key.includes(debtAccountKey(query)) && (side === 'all' ||
      [...item.balances.values()].some(balance => side === 'receivable' ? balance.amount > 0 : balance.amount < 0)));
    return <>
      <section className="panel filters debt-filters">
        <div className="debt-filter-options" role="group" aria-label={t('فلترة الحسابات', 'Filter accounts')}>
          {filters.map(([value, label]) => <button key={value} className="btn secondary" aria-pressed={side === value} onClick={() => setSide(value)}>{label}</button>)}
        </div>
        <label className="field"><span>{t('بحث بالاسم', 'Search by name')}</span><input value={query} onChange={event => setQuery(event.target.value)} /></label>
      </section>
      {!visible.length && <section className="panel"><Empty>{t('لا توجد حسابات.', 'No accounts.')}</Empty></section>}
      <div className="cards">{visible.map(item => <article className="panel record-card" key={item.key}>
        <h2>{item.name}</h2>
        <AccountBalance account={item} lang={lang} />
        <button className="btn secondary" onClick={() => select(item.key)}>{t('عرض الحساب', 'Open account')}</button>
      </article>)}</div>
    </>;
  }

  const buckets = [...account.balances.values()];
  const currency = new Set(buckets.map(bucket => bucket.currency)).size === 1 ? buckets[0].currency : undefined;
  const scope = new Set(buckets.map(bucket => bucket.scope)).size === 1 ? buckets[0].scope : undefined;
  const movement = (direction: MovementDirection) => edit({ type: 'movement', party: account.name, direction, currency, scope });
  const groups = new Map<string, Entry[]>();
  for (const row of account.entries) {
    const key = row.debt_movement_id ? [row.debt_movement_id, row.date, row.currency, row.scope, row.opening, movementDirection(row)].join('/') : row.id;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return <section className="panel record-card shipment-detail">
    <button className="btn secondary" onClick={() => select(null)}><ArrowLeft className="shipment-back" size={15} />{t('كل الحسابات', 'All accounts')}</button>
    <h2>{account.name}</h2>
    <AccountBalance account={account} lang={lang} />
    <div className="actions">
      <button className="btn primary" onClick={() => movement('take')}><ArrowDownLeft size={16} />{t('أخذت منه', 'Received')}</button>
      <button className="btn secondary" onClick={() => movement('give')}><ArrowUpRight size={16} />{t('أعطيته', 'Paid')}</button>
    </div>
    <div className="manifest-picker">
      <h3>{t('حركات الحساب', 'Account movements')}</h3>
      {[...groups].map(([key, rows]) => {
        const first = rows[0];
        const inbound = movementDirection(first) === 'take';
        const title = first.kind === 'purchase' ? t('فاتورة آجلة', 'Purchase on credit') : first.opening
          ? (inbound ? t('رصيد افتتاحي علينا', 'Opening payable') : t('رصيد افتتاحي لنا', 'Opening receivable'))
          : inbound ? t('أخذت منه', 'Received') : t('أعطيته', 'Paid');
        const amount = rows.reduce((sum, row) => sum + (row.kind === 'purchase' ? debtPrincipal(row) : row.amount), 0);
        return <article className="purchase-item account-movement" key={key}>
          <div className="manifest-invoice-head"><div><strong>{title}</strong><small><bdi>{first.date}</bdi> · {first.scope === 'personal' ? t('شخصي', 'Personal') : t('تجاري', 'Business')}</small></div>
            <strong><MoneyAmount amount={amount} currency={first.currency} lang={lang} /></strong></div>
          {first.description !== title && <p>{first.description}</p>}
          {rows.length === 1 ? <AccountActions row={first} account={account} lang={lang} edit={edit} onReceipt={onReceipt} /> :
            <details className="detail"><summary>{t('تفاصيل توزيع المبلغ', 'Allocation details')}</summary>
              {rows.map(row => <div className="split-line account-part" key={row.id}>
                <span>{row.settles_id ? t('تسوية دين', 'Debt payment') : t('دين جديد', 'New debt')} <MoneyAmount amount={row.amount} currency={row.currency} lang={lang} /></span>
                <AccountActions row={row} account={account} lang={lang} edit={edit} onReceipt={onReceipt} />
              </div>)}
            </details>}
        </article>;
      })}
      {account.open.length > 0 && <details className="detail">
        <summary>{t('الديون المفتوحة', 'Open debts')}</summary>
        {account.open.map(({ entry, amount }) => <div className="split-line account-part" key={entry.id}>
          <span>{entry.description} · <bdi>{entry.date}</bdi> · <MoneyAmount amount={amount} currency={entry.currency} lang={lang} /></span>
          <button className="btn secondary" onClick={() => edit({ type: 'settlement', debt: entry })}>
            {debtSide(entry) === 'payable' ? t('سداد هذا الدين', 'Pay this debt') : t('تحصيل هذا الدين', 'Collect this debt')}
          </button>
        </div>)}
      </details>}
    </div>
  </section>;
}
