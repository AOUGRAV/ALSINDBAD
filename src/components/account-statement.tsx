import { today, type Entry, type Lang } from '@/lib/domain';
import { translate } from './forms';
import { MoneyAmount } from './money-amount';

type StatementBalance = Pick<Entry, 'amount' | 'currency' | 'scope'>;
export type StatementMovement = Pick<Entry, 'date' | 'amount' | 'currency' | 'scope' | 'description'> & { key: string; label: string };

export function AccountStatement({ name, balances, movements, lang }: {
  name: string; balances: StatementBalance[]; movements: StatementMovement[]; lang: Lang;
}) {
  const t = translate(lang);
  const scope = (value: Entry['scope']) => value === 'personal' ? t('شخصي', 'Personal') : t('تجاري', 'Business');
  return <section className="account-statement" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
    <header className="statement-header">
      <div><p className="statement-brand"><span lang="ar">السندباد</span> <span lang="en">ALSINDBAD</span></p>
        <h1>{t('كشف حساب', 'Account statement')}</h1><p className="statement-name">{name}</p></div>
      <div className="statement-date">{t('تاريخ الإصدار', 'Issued on')}<bdi>{today()}</bdi></div>
    </header>
    <section className="statement-summary">
      <h2>{t('الرصيد الحالي', 'Current balance')}</h2>
      {!balances.length && <p>{t('الرصيد صفر', 'Zero balance')}</p>}
      <div className="statement-balances">{balances.map(balance => <div key={balance.currency + balance.scope}>
        <span>{balance.amount > 0 ? t('لنا', 'Owed to us') : balance.amount < 0 ? t('علينا', 'We owe') : t('مسدّد', 'Settled')} · {scope(balance.scope)}</span>
        <strong><MoneyAmount amount={Math.abs(balance.amount)} currency={balance.currency} lang={lang} /></strong>
      </div>)}</div>
    </section>
    <h2>{t('الحركات', 'Movements')}</h2>
    <table className="statement-table">
      <colgroup><col className="statement-date-column" /><col /><col className="statement-amount-column" /></colgroup>
      <thead><tr><th scope="col">{t('التاريخ', 'Date')}</th><th scope="col">{t('الحركة', 'Movement')}</th><th scope="col">{t('المبلغ', 'Amount')}</th></tr></thead>
      <tbody>{[...movements].reverse().map(row => <tr key={row.key}>
        <td><bdi>{row.date}</bdi></td>
        <td><strong>{row.label}</strong> <span className="statement-scope">· {scope(row.scope)}</span>
          {row.description !== row.label && <span className="statement-description">{row.description}</span>}</td>
        <td><MoneyAmount amount={row.amount} currency={row.currency} lang={lang} /></td>
      </tr>)}</tbody>
    </table>
  </section>;
}
