'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ChartNoAxesCombined, CircleDollarSign, ClipboardList, Globe2, LayoutDashboard, LockKeyhole, LogOut, MapPin, Menu, Plus, ReceiptText, RefreshCw, Ship, ShoppingBag, X } from 'lucide-react';
import { activeEntries, emptyData, type Container, type Dataset, type Lang } from '@/lib/domain';
import { advanceContainer, configured, downloadReceipt, loadData, reviseEntry, saveContainerManifest, saveEntry, saveLoad, supabase, uploadReceipt } from '@/lib/storage';
import { EditorDialog, errorMessage, translate, type Editor, type RecordChange } from './forms';
import { DebtEditorDialog } from './debt-editor';
import { PurchaseEditorDialog } from './purchase-editor';
import { ShipmentEditor } from './shipment-editor';
import { Shipments } from './shipments';
import { Dashboard, Debts, Ledger } from './views';
import { Reports } from './reports';

const navigation = [
  { id: 'overview', labels: ['نظرة عامة', 'Overview'], icon: LayoutDashboard },
  { id: 'ledger', labels: ['الحركات المالية', 'Transactions'], icon: ClipboardList },
  { id: 'purchases', labels: ['المشتريات والمصاريف', 'Purchases and expenses'], icon: ShoppingBag },
  { id: 'debts', labels: ['الديون والسلف', 'Debts and advances'], icon: CircleDollarSign },
  { id: 'shipments', labels: ['الحاويات والشحن', 'Containers'], icon: Ship },
  { id: 'receipts', labels: ['الفواتير', 'Invoices'], icon: ReceiptText },
  { id: 'reports', labels: ['التقارير', 'Reports'], icon: ChartNoAxesCombined },
] as const;
type Section = typeof navigation[number]['id'];
const languageKey = 'alsindbad.language';

function Brand({ logoOnly = false }: { logoOnly?: boolean }) {
  return <div className="brand">
    <span className="brand-logo"><img src="/brand/alsindbad-logo.svg" width={767} height={771} alt={logoOnly ? 'ALSINDBAD' : ''} /></span>
    {!logoOnly && <div><strong lang="ar">السندباد</strong><small lang="en">ALSINDBAD</small></div>}
  </div>;
}

export default function Workspace() {
  const [lang, setLang] = useState<Lang>('ar');
  const [userId, setUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(!configured);
  const [data, setData] = useState<Dataset>(emptyData);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('overview');
  const [purchaseView, setPurchaseView] = useState<'purchase' | 'expense'>('purchase');
  const [containerId, setContainerId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const t = translate(lang);

  useEffect(() => {
    try {
      if (localStorage.getItem(languageKey) === 'en') setLang('en');
    } catch { /* Continue with the default language. */ }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);
  useEffect(() => {
    if (!configured) return;
    try {
      const { data: auth } = supabase().auth.onAuthStateChange((_event, session) => {
        setUserId(session?.user.id ?? null);
        setAuthReady(true);
      });
      return () => auth.subscription.unsubscribe();
    } catch (problem) {
      setError(errorMessage(problem));
      setAuthReady(true);
    }
  }, []);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    setError('');
    loadData().then(result => {
      if (active) { setData(result); setLoadedFor(userId); }
    }).catch(problem => { if (active) { setLoadedFor(null); setError(errorMessage(problem)); } });
    return () => { active = false; };
  }, [userId, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 4200);
    return () => clearTimeout(timeout);
  }, [notice]);

  function switchLanguage() {
    const next = lang === 'ar' ? 'en' : 'ar';
    setLang(next);
    try { localStorage.setItem(languageKey, next); } catch { /* Preference lasts for this page. */ }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const { error: problem } = await supabase().auth.signInWithPassword({ email: String(form.get('email')).trim(), password: String(form.get('password')) });
      if (problem) setError(t('تعذر تسجيل الدخول. تحقق من البريد وكلمة المرور.', 'Sign-in failed. Check your email and password.'));
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  async function exitWorkspace() {
    setError('');
    setBusy(true);
    try {
      const { error: problem } = await supabase().auth.signOut({ scope: 'local' });
      if (problem) throw problem;
      setUserId(null);
      setData(emptyData());
      setLoadedFor(null);
      setSection('overview');
      setPurchaseView('purchase');
      setContainerId(null);
      setEditor(null);
      setMenu(false);
      setNotice('');
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  function navigate(target: Section) {
    setSection(target);
    setMenu(false);
    setError('');
    window.scrollTo(0, 0);
  }
  async function record(change: RecordChange) {
    if (change.type === 'entry') {
      const entry = change.value;
      if (change.receipt) entry.receipt_path = await uploadReceipt(change.receipt, entry.id);
      if (change.original) await reviseEntry(change.original, change.reason, entry);
      else await saveEntry(entry);
    } else if (change.type === 'void') {
      await reviseEntry(change.original, change.reason, null);
    } else if (change.type === 'manifest') {
      await saveContainerManifest(change.value, change.lines, change.expected);
      setContainerId(change.value.id);
    } else {
      await saveLoad(change.value);
    }
    setRefresh(n => n + 1);
    setNotice(change.type === 'void' ? t('أُزيلت الحركة من الأرصدة.', 'Transaction removed from balances.') : t('تم الحفظ بنجاح.', 'Saved successfully.'));
  }
  async function changeStatus(container: Container) {
    if (updating || container.status === 'arrived') return;
    setError('');
    setUpdating(container.id);
    try {
      await advanceContainer(container);
      setRefresh(n => n + 1);
      setNotice(t('تم تحديث حالة الحاوية.', 'Container status updated.'));
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setUpdating(''); }
  }
  async function receipt(path: string) {
    setError('');
    try { await downloadReceipt(path); }
    catch (problem) { setError(errorMessage(problem)); }
  }
  const languageButton = <button className="btn secondary lang-btn" onClick={switchLanguage}><Globe2 size={16} /><span>{t('English', 'العربية')}</span></button>;

  if (!authReady || !userId) return <main className="gate">
    <div className="gate-top">{languageButton}</div>
    <div className="gate-grid">
      <div className="gate-art"><Brand logoOnly /></div>
      <section className="gate-card">
        <span className="metric-icon green"><LockKeyhole size={20} /></span>
        <h1>{!authReady ? t('جارٍ التحميل…', 'Loading…') : configured ? t('تسجيل الدخول', 'Sign in') : t('مساحة عمل خاصة', 'Private workspace')}</h1>
        {authReady && (configured ?
          <form className="login-form" onSubmit={signIn}>
            <label className="field"><span>{t('البريد الإلكتروني', 'Email address')}</span><input type="email" dir="ltr" name="email" autoComplete="username" required /></label>
            <label className="field"><span>{t('كلمة المرور', 'Password')}</span><input type="password" dir="ltr" name="password" autoComplete="current-password" required /></label>
            <button className="btn primary" disabled={busy}>{busy ? t('جارٍ الدخول…', 'Signing in…') : t('دخول', 'Sign in')}</button>
          </form>
          : <p>{t('مساحة العمل بانتظار تفعيل تسجيل الدخول.', 'Sign-in setup is required to open this workspace.')}</p>)}
        {error && <p className="error-box" role="alert">{error}</p>}
      </section>
    </div>
  </main>;

  const current = navigation.find(page => page.id === section)!;
  const entries = [...data.entries].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const currentEntries = activeEntries(entries);
  const ready = loadedFor === userId;
  const expenseView = section === 'purchases' && purchaseView === 'expense';
  const action = section === 'shipments' ? t('حاوية جديدة', 'New container') : expenseView ? t('إضافة مصروف', 'Add expense') :
    section === 'purchases' || section === 'receipts' ? t('إضافة فاتورة', 'Add invoice') : section === 'debts' ? t('إضافة دين', 'Add debt') : t('عملية جديدة', 'New transaction');
  function openEditor() {
    if (section === 'shipments') setEditor({ type: 'manifest' });
    else if (section === 'debts') setEditor({ type: 'debt' });
    else if (expenseView) setEditor({ type: 'entry', kind: 'expense', expenseOnly: true });
    else if (section === 'purchases' || section === 'receipts') setEditor({ type: 'purchase' });
    else setEditor({ type: 'entry', kind: 'expense' });
  }

  return <div className="workspace">
    {menu && <button className="sidebar-overlay no-print" aria-label={t('إغلاق القائمة', 'Close navigation')} onClick={() => setMenu(false)} />}
    <aside className={'sidebar no-print' + (menu ? ' sidebar-open' : '')}>
      <Brand />
      <div className="branch"><span className="branch-icon"><MapPin size={17} /></span><strong>{t('فرع جدة', 'Jeddah branch')}</strong></div>
      <nav aria-label={t('القائمة الرئيسية', 'Main navigation')}>{navigation.map(({ id, labels, icon: Icon }) => <button key={id} className={id === section ? 'nav-active' : ''} aria-current={id === section ? 'page' : undefined} onClick={() => navigate(id)}>
        <Icon size={18} strokeWidth={1.8} /><span>{t(labels[0], labels[1])}</span>
      </button>)}</nav>
      <div className="sidebar-bottom">
        <button className="btn sidebar-exit" disabled={busy} onClick={exitWorkspace}><LogOut size={17} />{t('تسجيل الخروج', 'Sign out')}</button>
      </div>
    </aside>
    <div className="app-content">
      <header className="topbar no-print">
        <button className="icon-btn mobile-menu" onClick={() => setMenu(!menu)} aria-label={t('القائمة', 'Menu')} aria-expanded={menu}>{menu ? <X size={20} /> : <Menu size={20} />}</button>
        <div className="actions">{ready && <button className="icon-btn" onClick={() => setRefresh(n => n + 1)} aria-label={t('تحديث البيانات', 'Refresh data')}><RefreshCw size={16} /></button>}{languageButton}</div>
      </header>
      <main className="main-content">
        <div className="page-heading no-print"><h1>{t(current.labels[0], current.labels[1])}</h1>
          {ready && section !== 'reports' && <button className="btn primary" onClick={openEditor}><Plus size={19} />{action}</button>}
        </div>
        {error && <div className="error-box no-print" role="alert">{error}{!ready && <button className="btn secondary" onClick={() => setRefresh(n => n + 1)}>{t('إعادة المحاولة', 'Retry')}</button>}</div>}
        {!ready && !error && <p role="status" className="panel empty">{t('جارٍ تحميل السجلات…', 'Loading records…')}</p>}
        {ready && <>
          {section === 'overview' && <Dashboard data={data} entries={currentEntries} lang={lang} navigate={navigate} onReceipt={receipt} edit={setEditor} />}
          {(section === 'ledger' || section === 'receipts') && <Ledger key={section} entries={entries} lang={lang} kind={section === 'receipts' ? 'receipts' : undefined} onReceipt={receipt} edit={setEditor} />}
          {section === 'purchases' && <>
            <div className="actions purchase-switch" role="group" aria-label={t('المشتريات والمصاريف', 'Purchases and expenses')}>
              <button className="btn secondary" aria-pressed={purchaseView === 'purchase'} onClick={() => setPurchaseView('purchase')}>{t('المشتريات', 'Purchases')}</button>
              <button className="btn secondary" aria-pressed={purchaseView === 'expense'} onClick={() => setPurchaseView('expense')}>{t('المصاريف', 'Expenses')}</button>
            </div>
            <Ledger key={purchaseView} entries={entries} lang={lang} kind={purchaseView} onReceipt={receipt} edit={setEditor} />
          </>}
          {section === 'debts' && <Debts entries={currentEntries} lang={lang} edit={setEditor} />}
          {section === 'shipments' && <Shipments data={data} lang={lang} selected={containerId} select={setContainerId} edit={setEditor} advance={changeStatus} updating={updating} onReceipt={receipt} />}
          {section === 'reports' && <Reports data={data} lang={lang} />}
        </>}
      </main>
    </div>
    {notice && <div className="toast no-print" role="status">{notice}</div>}
    {editor && ready && (editor.type === 'manifest'
      ? <ShipmentEditor container={editor.container} data={data} lang={lang} close={() => setEditor(null)} save={record} />
      : editor.type === 'purchase'
      ? <PurchaseEditorDialog editor={editor} data={data} lang={lang} close={() => setEditor(null)} save={record} />
      : editor.type === 'debt' || editor.type === 'settlement'
      ? <DebtEditorDialog editor={editor} data={data} lang={lang} close={() => setEditor(null)} save={record} />
      : <EditorDialog editor={editor} data={data} lang={lang} close={() => setEditor(null)} save={record} onReceipt={receipt} openPurchase={() => setEditor({ type: 'purchase' })} />)}
  </div>;
}
