import { money, type Currency, type Lang } from '@/lib/domain';
import { poundsFromRiyals } from '@/lib/pounds';

export function PoundEquivalent({ amount, lang }: { amount: number | null; lang: Lang }) {
  if (amount === null || !Number.isInteger(amount)) return null;
  return <bdi className="money-equivalent">{money(poundsFromRiyals(amount), 'GBP', lang)}</bdi>;
}

export function MoneyAmount({ amount, currency = 'SAR', lang }: { amount: number | null; currency?: Currency; lang: Lang }) {
  if (amount === null) return <bdi>—</bdi>;
  return <span className="money-amount">
    <bdi>{money(amount, currency, lang)}</bdi>
    {currency === 'SAR' && <PoundEquivalent amount={amount} lang={lang} />}
  </span>;
}
