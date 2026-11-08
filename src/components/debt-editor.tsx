'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, X } from 'lucide-react';
import { currencies, debtBalance, debtSide, minor, money, prepareDebtEntry, rateForSarTotal, today, toSar, type Currency, type Dataset, type Entry, type Lang } from '@/lib/domain';
import { receiptAccept, receiptExtension } from '@/lib/receipt';
import { Field, errorMessage, translate, type DebtEditor, type RecordChange } from './forms';

export function DebtEditorDialog({ editor, data, lang, close, save }: {
  editor: DebtEditor; data: Dataset; lang: Lang; close: () => void; save: (change: RecordChange) => Promise<void>;
}) {
  const t = translate(lang);
  const original = editor.original;
  const debt = editor.type === 'settlement' ? editor.debt : undefined;
  const receivable = debt && debtSide(debt) === 'receivable';
  const balance = debt ? debtBalance(debt, data.entries.filter(row => row.id !== original?.id)) : 0;
  const hasPayments = Boolean(original && !debt && data.entries.some(row => !row.voided_at && row.settles_id === original.id));
  const paymentTitle = receivable ? t('استلام دفعة', 'Record money received') : t('سداد دفعة', 'Record payment sent');
  const title = original ? (debt ? t('تعديل الدفعة', 'Edit payment') : t('تعديل الدين', 'Edit debt')) : debt ? paymentTitle : t('إضافة دين', 'Add debt');
  const defaultDate = original?.date ?? today();
  const originalSar = original ? toSar(original.amount, original.rate) : null;
  const [currency, setCurrency] = useState<Currency>(original?.currency ?? debt?.currency ?? 'SAR');
  const [amount, setAmount] = useState(original ? (original.amount / 100).toFixed(2) : '');
  const [exchangeInput, setExchangeInput] = useState<'total' | 'rate'>(originalSar === 0 ? 'rate' : 'total');
  const [exchangeValue, setExchangeValue] = useState(() => {
    if (!original || original.currency === 'SAR' || originalSar === null) return '';
    return originalSar === 0 ? String(original.rate) : (originalSar / 100).toFixed(2);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const identity = useRef<Pick<Entry, 'id' | 'created_at'> | null>(null);
  const principal = minor(amount);
  const enteringTotal = exchangeInput === 'total';
  const enteredTotal = minor(exchangeValue);
  const enteredRate = Number(exchangeValue);
  const directRate = enteredRate > 0 && enteredRate <= 10_000 &&
    Math.round(enteredRate * 1_000_000) / 1_000_000 === enteredRate ? enteredRate : null;
  const sameQuote = original && original.currency === currency && principal === original.amount && enteredTotal === originalSar;
  const impliedRate = sameQuote ? original.rate : rateForSarTotal(principal, enteredTotal);
  const rate = currency === 'SAR' ? 1 : enteringTotal ? impliedRate : directRate;
  const sarTotal = rate !== null && Number.isSafeInteger(principal) && principal > 0 && principal <= 100_000_000_000
    ? toSar(principal, rate) : null;
  const roundedTotal = currency !== 'SAR' && enteringTotal && sarTotal !== null && enteredTotal !== sarTotal ? sarTotal : null;
  let exchangeHint = enteringTotal ? t('اكتب قيمة المبلغ كاملًا بالريال.', 'Enter the full amount in Saudi riyals.') :
    t('اكتب سعر وحدة واحدة من العملة.', 'Enter the rate for one unit of the currency.');
  if (roundedTotal !== null) exchangeHint = t('أقرب إجمالي يمكن حفظه', 'Nearest total that can be saved') + ' ' + money(roundedTotal, 'SAR', lang);
  else if (sarTotal !== null) exchangeHint = enteringTotal ? t('سعر الصرف المحسوب', 'Calculated exchange rate') + ' ' + rate :
    t('الإجمالي بالريال', 'Total in SAR') + ' ' + money(sarTotal, 'SAR', lang);

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);

  function changeCurrency(next: Currency) {
    setCurrency(next);
    setExchangeInput('total');
    setExchangeValue('');
    setError('');
  }

  function switchExchangeInput() {
    if (enteringTotal) {
      setExchangeInput('rate');
      setExchangeValue(rate !== null && roundedTotal === null ? String(rate) : '');
    } else {
      setExchangeInput('total');
      setExchangeValue(sarTotal === null ? '' : (sarTotal / 100).toFixed(2));
    }
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '').trim();
    const direction = original && !debt ? debtSide(original) : value('direction');
    if (!debt && direction !== 'receivable' && direction !== 'payable') {
      setError(t('اختر «لنا» أو «علينا».', 'Choose who owes the money.'));
      return;
    }
    if (rate === null || roundedTotal !== null) {
      setError(roundedTotal !== null
        ? t('اختر المبلغ المقرب أو أدخل سعر الصرف قبل الحفظ.', 'Accept the rounded amount or enter the exchange rate before saving.')
        : t('تحقق من المبلغ بالريال أو من سعر الصرف.', 'Check the SAR total or the exchange rate.'));
      return;
    }
    setError('');
    setBusy(true);
    try {
      identity.current ??= original ? { id: original.id, created_at: original.created_at } : { id: crypto.randomUUID(), created_at: new Date().toISOString() };
      const fields = {
        ...identity.current,
        date: value('date') || defaultDate,
        amount: principal,
        rate,
        method: value('method') as Entry['method'],
        description: value('note') || (debt ? paymentTitle : direction === 'receivable' ? t('دين لنا', 'Owed to us') : t('دين علينا', 'We owe')),
      };
      const entry = prepareDebtEntry(debt ? { ...fields, debt } : {
        ...fields, direction: direction === 'receivable' ? 'receivable' : 'payable',
        party: value('party'), category: original?.category ?? t('ديون', 'Debts'), currency,
        scope: (value('scope') || original?.scope) as Entry['scope'], opening: form.has('opening'),
      }, data, original);
      const attachment = form.get('receipt');
      const receipt = attachment instanceof File && attachment.size ? attachment : undefined;
      if (receipt) receiptExtension(receipt);
      await save({ type: 'entry', value: entry, receipt, original, reason: original ? t('تعديل من شاشة الديون', 'Edited from the debts screen') : '' });
      close();
    } catch (problem) {
      setError(problem && typeof problem === 'object' && 'issues' in problem && Array.isArray(problem.issues)
        ? String(problem.issues[0]?.message) : errorMessage(problem));
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="editor debt-editor" aria-labelledby="debt-editor-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header className="dialog-head">
      <h2 id="debt-editor-title">{title}</h2>
      <button type="button" className="icon-btn" aria-label={t('إغلاق', 'Close')} onClick={close} disabled={busy}><X size={19} /></button>
    </header>
    <form onSubmit={submit}>
      <fieldset className="debt-editor-fields" disabled={busy}>
        <div className="form-grid">
          {debt ? <p className="field-wide form-note">{debt.party} · {t('المتاح لهذه الدفعة', 'Available for this payment')}: <bdi>{money(balance, debt.currency, lang)}</bdi></p> : <>
            {original ? <p className="field-wide form-note">{debtSide(original) === 'receivable' ? t('دين لنا', 'Owed to us') : t('دين علينا', 'We owe')}</p> :
            <fieldset className="field-wide debt-direction">
              <legend>{t('الدين لمين؟', 'Who owes the money?')}</legend>
              <div className="debt-direction-options">
                <label className="debt-option">
                  <input type="radio" name="direction" value="receivable" required />
                  <span><strong>{t('لنا', 'Owed to us')}</strong><small>{t('أنا أعطيت شخصًا مبلغًا', 'I lent someone money')}</small></span>
                </label>
                <label className="debt-option">
                  <input type="radio" name="direction" value="payable" required />
                  <span><strong>{t('علينا', 'We owe')}</strong><small>{t('شخص أعطاني مبلغًا', 'Someone lent me money')}</small></span>
                </label>
              </div>
            </fieldset>}
            <Field title={t('اسم الشخص أو الجهة', 'Person or company')} wide><input name="party" defaultValue={original?.party} readOnly={hasPayments} maxLength={120} required /></Field>
          </>}
          <Field title={debt ? t('مبلغ الدفعة', 'Payment amount') + ' (' + currency + ')' : t('المبلغ', 'Amount')} wide={Boolean(debt)}>
            <input name="amount" type="number" inputMode="decimal" min="0.01" max={debt ? balance / 100 : 1000000000} step="0.01" value={amount} onChange={event => setAmount(event.target.value)} required />
          </Field>
          {!debt && <Field title={t('العملة', 'Currency')}>
            <select value={currency} disabled={hasPayments} onChange={event => changeCurrency(event.target.value as Currency)}>
              {currencies.map(code => <option key={code} value={code}>{code === 'SAR' ? t('ريال سعودي', 'Saudi riyal') : code}</option>)}
            </select>
          </Field>}
          {currency !== 'SAR' && <div className="field-wide debt-exchange">
            <Field title={enteringTotal ? t('إجمالي المبلغ بالريال', 'Total in SAR') :
              t('سعر صرف 1', 'SAR per 1') + ' ' + currency + (lang === 'ar' ? ' بالريال' : '')}>
              <input type="number" inputMode="decimal" value={exchangeValue}
                min={enteringTotal ? '0.01' : '0.000001'} max={enteringTotal ? undefined : '10000'}
                step={enteringTotal ? '0.01' : '0.000001'}
                onChange={event => { setExchangeValue(event.target.value); setError(''); }} required />
            </Field>
            <div className="debt-exchange-options">
              <p className="muted" aria-live="polite" dir="auto">{exchangeHint}</p>
              {roundedTotal !== null && <button className="btn secondary" type="button" onClick={() => {
                setExchangeValue((roundedTotal / 100).toFixed(2));
                setError('');
              }}>{t('استخدم المبلغ المقرب', 'Use rounded total')}</button>}
              <button className="text-btn" type="button" onClick={switchExchangeInput}>{enteringTotal
                ? t('أدخل سعر الصرف بدلًا منه', 'Enter the exchange rate instead')
                : t('أدخل الإجمالي بالريال بدلًا منه', 'Enter the total in SAR instead')}</button>
            </div>
          </div>}
        </div>
        <details className="debt-more">
          <summary>{t('تفاصيل اختيارية', 'Optional details')}</summary>
          <div className="form-grid">
            <Field title={t('التاريخ', 'Date')}><input name="date" type="date" defaultValue={defaultDate} /></Field>
            <Field title={t('طريقة الدفع', 'Payment method')}><select name="method" defaultValue={original?.method ?? 'bank'}>
              <option value="bank">{t('تحويل بنكي', 'Bank transfer')}</option><option value="cash">{t('نقدًا', 'Cash')}</option><option value="card">{t('بطاقة', 'Card')}</option>
            </select></Field>
            {!debt && <Field title={t('النطاق', 'Scope')}><select name="scope" defaultValue={original?.scope ?? 'business'} disabled={hasPayments}>
              <option value="business">{t('تجاري', 'Business')}</option><option value="personal">{t('شخصي', 'Personal')}</option>
            </select></Field>}
            <Field title={t('ملاحظة', 'Note')} wide><input name="note" maxLength={500} defaultValue={original?.description} /></Field>
            <Field title={original?.receipt_path ? t('استبدال المستند', 'Replace document') : t('إرفاق مستند', 'Attach document')} wide><input name="receipt" type="file" accept={receiptAccept} /></Field>
            {!debt && <label className="check-field field-wide"><input name="opening" type="checkbox" defaultChecked={original?.opening} />
              {t('دين قديم، بدون حركة جديدة في النقد', 'Existing debt with no new cash movement')}
            </label>}
          </div>
        </details>
      </fieldset>
      {error && <p className="error-box" role="alert">{error}</p>}
      <footer className="dialog-actions">
        <button className="btn secondary" type="button" onClick={close} disabled={busy}>{t('رجوع', 'Back')}</button>
        <button className="btn primary" type="submit" disabled={busy}><Check size={17} />{busy ? t('جارٍ الحفظ…', 'Saving…') : debt ? t('حفظ الدفعة', 'Save payment') : t('حفظ الدين', 'Save debt')}</button>
      </footer>
    </form>
  </dialog>;
}
