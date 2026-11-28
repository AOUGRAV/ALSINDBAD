'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { money, type Lang } from '@/lib/domain';
import { expenseStages, pricingRate, toPounds, unitPricing, type PricingCurrency, type PricingExpense, type PricingItem } from '@/lib/pricing';
import { Field, translate } from './forms';

const poundFormat = new Intl.NumberFormat('en-GB', {style: 'currency', currency: 'GBP'});

export function PricingMoney({ value, lang }: { value: number | null; lang: Lang }) {
  return value === null ? <span>—</span> : <span className="money-amount">
    <bdi dir="ltr">{poundFormat.format(value)}</bdi>
    <bdi className="money-equivalent">{money(Math.round(value * pricingRate * 100), 'SAR', lang)}</bdi>
  </span>;
}

export function PricingDialog({ title, lang, close, children }: {title: string; lang: Lang; close: () => void; children: ReactNode}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog className="editor" ref={ref} aria-labelledby={heading} onCancel={event => {event.preventDefault(); close();}}>
    <header className="dialog-head"><h2 id={heading}>{title}</h2><button type="button" className="icon-btn" onClick={close} aria-label={translate(lang)('إغلاق', 'Close')}><X size={18} /></button></header>
    {children}
  </dialog>;
}

const value = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const numeric = (form: FormData, key: string) => Number(value(form, key));
const optional = (form: FormData, key: string) => value(form, key) === '' ? null : numeric(form, key);
const limit = 1_000_000_000_000;

export function PricingRowEditor({ editor, lang, close, applyItem, applyExpense }: {
  editor: {type: 'item'; row?: PricingItem} | {type: 'expense'; row?: PricingExpense};
  lang: Lang; close: () => void; applyItem: (row: PricingItem) => void; applyExpense: (row: PricingExpense) => void;
}) {
  const t = translate(lang);
  const [error, setError] = useState('');
  const item = editor.type === 'item' ? editor.row : undefined;
  const expense = editor.type === 'expense' ? editor.row : undefined;
  const [purchaseCurrency, setPurchaseCurrency] = useState<PricingCurrency>('GBP');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = editor.row?.id ?? crypto.randomUUID();
    if (editor.type === 'item') {
      const english = value(form, 'english'), name = value(form, 'name');
      if (!name && !english) {setError(t('اكتب اسم المنتج بالعربي أو الإنجليزي.', 'Enter an Arabic or English product name.')); return;}
      applyItem({id, source: item?.source, name, english, unit: value(form, 'unit'), quantity: numeric(form, 'quantity'),
        purchase: toPounds(numeric(form, 'purchase'), purchaseCurrency), pack: numeric(form, 'pack'), sale: optional(form, 'sale')});
    } else {
      const label = value(form, 'label');
      if (!label) {setError(t('اكتب اسم المصروف.', 'Enter an expense name.')); return;}
      applyExpense({id, label, stage: value(form, 'stage') as PricingExpense['stage'], amount: numeric(form, 'amount'), currency: value(form, 'currency') as PricingCurrency});
    }
    close();
  }
  return <PricingDialog lang={lang} close={close} title={editor.type === 'item'
    ? editor.row ? t('تعديل المنتج', 'Edit product') : t('إضافة منتج', 'Add product')
    : editor.row ? t('تعديل المصروف', 'Edit expense') : t('إضافة مصروف', 'Add expense')}>
    <form className="dialog-body" onSubmit={submit}>
      <div className="form-grid">
        {editor.type === 'item' ? <>
          <Field title={t('اسم المنتج بالإنجليزي', 'English product name')}><input name="english" dir="ltr" maxLength={180} defaultValue={item?.english} /></Field>
          <Field title={t('اسم المنتج بالعربي', 'Arabic product name')}><input name="name" dir="rtl" maxLength={180} defaultValue={item?.name} /></Field>
          <Field title={t('الكمية', 'Quantity')}><input name="quantity" required type="number" inputMode="decimal" min="0.001" max="100000000" step="0.001" defaultValue={item?.quantity ?? 1} /></Field>
          <Field title={t('وحدة الشراء (كرتون، بالة…)', 'Purchase unit (carton, bale…)')}><input name="unit" required maxLength={40} pattern=".*\S.*" defaultValue={item?.unit ?? t('كرتون', 'Carton')} /></Field>
          <Field title={t('سعر شراء الوحدة', 'Purchase cost per unit')}><input name="purchase" required type="number" inputMode="decimal" min="0" max={limit} step="any" defaultValue={item?.purchase} /></Field>
          <Field title={t('عملة الشراء', 'Purchase currency')}><select value={purchaseCurrency} onChange={e => setPurchaseCurrency(e.target.value as PricingCurrency)}><option>GBP</option><option>SAR</option></select></Field>
          <Field title={t('عدد وحدات البيع في وحدة الشراء', 'Selling units per purchase unit')}><input name="pack" required type="number" inputMode="numeric" min="1" max="100000" step="1" defaultValue={item?.pack ?? 1} /></Field>
          <Field title={t('سعر البيع للوحدة (£)', 'Selling price per unit (£)')}><input name="sale" type="number" inputMode="decimal" min="0" max={limit} step="0.01" defaultValue={item?.sale ?? ''} /></Field>
        </> : <>
          <Field wide title={t('اسم المصروف', 'Expense name')}><input name="label" required maxLength={500} defaultValue={expense?.label} /></Field>
          <Field title={t('المبلغ', 'Amount')}><input name="amount" type="number" required min="0" max={limit} step="any" inputMode="decimal" defaultValue={expense?.amount} /></Field>
          <Field title={t('العملة', 'Currency')}><select name="currency" defaultValue={expense?.currency ?? 'GBP'}><option>GBP</option><option>SAR</option></select></Field>
          <Field wide title={t('المرحلة', 'Stage')}><select name="stage" defaultValue={expense?.stage ?? 'UK'}>
            <option value="">{t('غير محددة', 'Unspecified')}</option>{expenseStages.map((stage, i) => <option key={stage} value={stage}>{t(['بريطانيا', 'الشحن', 'جدة'][i], stage)}</option>)}
          </select></Field>
        </>}
      </div>
      {error && <p role="alert" className="error-box">{error}</p>}
      <footer className="dialog-actions"><button className="btn primary" type="submit">{t('تم', 'Done')}</button><button className="btn secondary" type="button" onClick={close}>{t('إلغاء', 'Cancel')}</button></footer>
    </form>
  </PricingDialog>;
}

export function QuickPricing({ lang, close }: { lang: Lang; close: () => void }) {
  const t = translate(lang);
  const [result, setResult] = useState<ReturnType<typeof unitPricing> | null>(null);
  return <PricingDialog lang={lang} close={close} title={t('حسبة سريعة', 'Quick calculator')}>
    <form className="dialog-body" onSubmit={e => e.preventDefault()} onChange={e => {
      const form = new FormData(e.currentTarget);
      const valid = Array.from(e.currentTarget.elements).every(el => !(el instanceof HTMLInputElement) || el.validity.valid);
      if (!valid) {setResult(null); return;}
      setResult(unitPricing(numeric(form, 'quantity'), toPounds(numeric(form, 'purchase'), value(form, 'currency') as PricingCurrency),
        numeric(form, 'expenses'), optional(form, 'sale'), numeric(form, 'pack')));
    }}>
      <div className="form-grid">
        <Field title={t('كمية الشراء', 'Purchase quantity')}><input name="quantity" type="number" required min="0.001" max="100000000" step="0.001" inputMode="decimal" defaultValue={1} /></Field>
        <Field title={t('عدد وحدات البيع في وحدة الشراء', 'Selling units per purchase unit')}><input name="pack" type="number" required min="1" max="100000" step="1" inputMode="numeric" defaultValue={1} /></Field>
        <Field title={t('سعر شراء الوحدة', 'Purchase cost per unit')}><input name="purchase" type="number" required min="0" max={limit} step="any" inputMode="decimal" /></Field>
        <Field title={t('عملة الشراء', 'Purchase currency')}><select name="currency" defaultValue="GBP"><option>GBP</option><option>SAR</option></select></Field>
        <Field title={t('إجمالي المصاريف التقديرية (£)', 'Total estimated expenses (£)')}><input name="expenses" type="number" min="0" max={limit} step="any" inputMode="decimal" placeholder="0" /></Field>
        <Field title={t('سعر البيع للوحدة (£)', 'Selling price per unit (£)')}><input name="sale" type="number" min="0" max={limit} step="0.01" inputMode="decimal" /></Field>
      </div>
      <div className="pricing-quick-result" aria-live="polite">
        <div className="split-line"><strong>{t('تكلفة وحدة البيع', 'Landed cost per selling unit')}</strong><PricingMoney lang={lang} value={result?.landed ?? null} /></div>
        <div className="split-line"><strong>{t('ربح الوحدة', 'Profit per unit')}</strong><PricingMoney lang={lang} value={result?.profit ?? null} /></div>
        <div className="split-line"><strong>{t('إجمالي الربح المتوقع', 'Expected total profit')}</strong><PricingMoney lang={lang} value={result?.totalProfit ?? null} /></div>
      </div>
    </form>
  </PricingDialog>;
}
