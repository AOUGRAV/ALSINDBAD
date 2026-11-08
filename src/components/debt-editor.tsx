'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, X } from 'lucide-react';
import { currencies, debtBalance, debtSide, minor, money, prepareDebtEntry, today, type Currency, type Dataset, type Entry, type Lang } from '@/lib/domain';
import { receiptAccept, receiptExtension } from '@/lib/receipt';
import { Field, errorMessage, translate, type DebtEditor, type RecordChange } from './forms';

export function DebtEditorDialog({ editor, data, lang, close, save }: {
  editor: DebtEditor; data: Dataset; lang: Lang; close: () => void; save: (change: RecordChange) => Promise<void>;
}) {
  const t = translate(lang);
  const debt = editor.type === 'settlement' ? editor.debt : undefined;
  const receivable = debt && debtSide(debt) === 'receivable';
  const balance = debt ? debtBalance(debt, data.entries) : 0;
  const title = debt ? (receivable ? t('استلام دفعة', 'Record money received') : t('سداد دفعة', 'Record payment sent')) : t('إضافة دين', 'Add debt');
  const defaultDate = today();
  const [currency, setCurrency] = useState<Currency>(debt?.currency ?? 'SAR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const identity = useRef<Pick<Entry, 'id' | 'created_at'> | null>(null);

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '').trim();
    const direction = value('direction');
    if (!debt && direction !== 'receivable' && direction !== 'payable') {
      setError(t('اختر «لنا» أو «علينا».', 'Choose who owes the money.'));
      return;
    }
    setError('');
    setBusy(true);
    try {
      identity.current ??= { id: crypto.randomUUID(), created_at: new Date().toISOString() };
      const fields = {
        ...identity.current,
        date: value('date') || defaultDate,
        amount: minor(value('amount')),
        rate: currency === 'SAR' ? 1 : Number(value('rate')),
        method: value('method') as Entry['method'],
        description: value('note') || (debt ? title : direction === 'receivable' ? t('دين لنا', 'Owed to us') : t('دين علينا', 'We owe')),
      };
      const entry = prepareDebtEntry(debt ? { ...fields, debt } : {
        ...fields, direction: direction === 'receivable' ? 'receivable' : 'payable',
        party: value('party'), category: t('ديون', 'Debts'), currency,
        scope: value('scope') as Entry['scope'], opening: form.has('opening'),
      }, data);
      const attachment = form.get('receipt');
      const receipt = attachment instanceof File && attachment.size ? attachment : undefined;
      if (receipt) receiptExtension(receipt);
      await save({ type: 'entry', value: entry, receipt, reason: '' });
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
          {debt ? <p className="field-wide form-note">{debt.party} · {t('المتبقي', 'Outstanding')}: <bdi>{money(balance, debt.currency, lang)}</bdi></p> : <>
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
            </fieldset>
            <Field title={t('اسم الشخص أو الجهة', 'Person or company')} wide><input name="party" maxLength={120} required /></Field>
          </>}
          <Field title={debt ? t('مبلغ الدفعة', 'Payment amount') + ' (' + currency + ')' : t('المبلغ', 'Amount')} wide={Boolean(debt)}>
            <input name="amount" type="number" inputMode="decimal" min="0.01" max={debt ? balance / 100 : 1000000000} step="0.01" required />
          </Field>
          {!debt && <Field title={t('العملة', 'Currency')}>
            <select value={currency} onChange={event => setCurrency(event.target.value as Currency)}>
              {currencies.map(code => <option key={code} value={code}>{code === 'SAR' ? t('ريال سعودي', 'Saudi riyal') : code}</option>)}
            </select>
          </Field>}
          {currency !== 'SAR' && <Field title={t('سعر الوحدة بالريال', 'SAR per currency unit')} wide>
            <input key={currency} name="rate" type="number" inputMode="decimal" min="0.000001" max="10000" step="0.000001" placeholder={debt ? String(debt.rate) : undefined} required />
          </Field>}
        </div>
        <details className="debt-more">
          <summary>{t('تفاصيل اختيارية', 'Optional details')}</summary>
          <div className="form-grid">
            <Field title={t('التاريخ', 'Date')}><input name="date" type="date" defaultValue={defaultDate} /></Field>
            <Field title={t('طريقة الدفع', 'Payment method')}><select name="method" defaultValue="bank">
              <option value="bank">{t('تحويل بنكي', 'Bank transfer')}</option><option value="cash">{t('نقدًا', 'Cash')}</option><option value="card">{t('بطاقة', 'Card')}</option>
            </select></Field>
            {!debt && <Field title={t('النطاق', 'Scope')}><select name="scope" defaultValue="business">
              <option value="business">{t('تجاري', 'Business')}</option><option value="personal">{t('شخصي', 'Personal')}</option>
            </select></Field>}
            <Field title={t('ملاحظة', 'Note')} wide><input name="note" maxLength={500} /></Field>
            <Field title={t('إرفاق مستند', 'Attach document')} wide><input name="receipt" type="file" accept={receiptAccept} /></Field>
            {!debt && <label className="check-field field-wide"><input name="opening" type="checkbox" />
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
