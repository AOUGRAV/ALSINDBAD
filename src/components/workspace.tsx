'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ChartNoAxesCombined, CircleDollarSign, ClipboardList, Globe2, LayoutDashboard, LockKeyhole, LogOut, MapPin, Menu, Plus, ReceiptText, RefreshCw, Ship, ShoppingBag, X } from 'lucide-react';
import { activeEntries, emptyData, type Container, type Dataset, type Lang } from '@/lib/domain';
import { advanceContainer, configured, downloadReceipt, loadData, reviseEntry, saveContainer, saveEntry, saveLoad, supabase, uploadReceipt } from '@/lib/storage';
import { EditorDialog, errorMessage, translate, type Editor, type RecordChange } from './forms';
import { DebtEditorDialog } from './debt-editor';
import { PurchaseEditorDialog } from './purchase-editor';
import { Dashboard, Debts, Ledger, Shipments } from './views';
import { Reports } from './reports';

const navigation = [
  { id: 'overview', labels: ['نظرة عامة', 'Overview'], description: ['ملخص حسابات ومشتريات فرع جدة في مكان واحد.', 'Your Jeddah accounts and operations in one place.'], icon: LayoutDashboard },
  { id: 'ledger', labels: ['الحركات المالية', 'Transactions'], description: ['تتبع التمويل والمصاريف والأصول وحركة النقد.', 'Track funding, expenses, assets, and cash movement.'], icon: ClipboardList },
  { id: 'purchases', labels: ['المشتريات', 'Purchases'], description: ['سجّل فواتير الشراء وتابع المبالغ المدفوعة والمتبقية.', 'Record purchase invoices and track amounts paid and outstanding.'], icon: ShoppingBag },
  { id: 'debts', labels: ['الديون والسلف', 'Debts and advances'], description: ['اعرف مين له عندك ومين عليه لك.', 'See who owes you and who you owe.'], icon: CircleDollarSign },
  { id: 'shipments', labels: ['الحاويات والشحن', 'Containers'], description: ['أدر تحميل البضائع وتابع تكاليف الحاويات والشحن.', 'Manage stock loading and track container and shipping costs.'], icon: Ship },
  { id: 'receipts', labels: ['الفواتير', 'Invoices'], description: ['استعرض فواتير الشراء وإيصالات الحركات المالية.', 'Find purchase invoices and transaction receipts.'], icon: ReceiptText },
  { id: 'reports', labels: ['التقارير', 'Reports'], description: ['صفِّ البيانات وصدّر تقارير فرع جدة إلى Excel أو PDF.', 'Filter Jeddah records and export reports to Excel or PDF.'], icon: ChartNoAxesCombined },
] as const;
type Section = typeof navigation[number]['id'];
const languageKey = 'alsindbad.language';

function Brand() {
  return <div className="brand">
    <span className="brand-logo"><img src="/brand/alsindbad-logo.svg" width={767} height={771} alt="" /></span>
    <div><strong>السندباد</strong><small>ALSINDBAD</small></div>
  </div>;
}

export default function Workspace() {
  const [lang, setLang] = useState<Lang>('ar');
  const [userId, setUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(!configured);
  const [data, setData] = useState<Dataset>(emptyData);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('overview');
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
    } else if (change.type === 'container') {
      await saveContainer(change.value);
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
      <section className="gate-art">
        <svg className="harbor-mark" viewBox="0 0 400 300" aria-hidden="true">
          <defs><pattern id="chart-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="currentColor" strokeOpacity=".23" /></pattern></defs>
          <rect width="400" height="300" fill="url(#chart-grid)" />
          <path d="M-12 251C55 193 86 244 142 196S205 92 251 104 306 160 409 57" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 6" />
          <circle cx="251" cy="104" r="42" fill="none" stroke="currentColor" strokeOpacity=".45" />
          <circle cx="251" cy="104" r="8" fill="currentColor" />
          <path d="M251 38v36m0 60v36m-66-66h36m60 0h36" stroke="currentColor" strokeOpacity=".5" />
        </svg>
        <Brand />
        <div><h1>{t('عمليات جدة، في مكان واحد.', 'Jeddah operations, in one place.')}</h1><p>{t('الحسابات والمشتريات والحاويات، من أول عملية إلى آخر شحنة.', 'Accounts, purchases, and containers from the first transaction to the last shipment.')}</p></div>
        <div className="gate-location"><MapPin size={16} />{t('جدة · المملكة العربية السعودية', 'Jeddah · Saudi Arabia')}</div>
      </section>
      <section className="gate-card">
        <span className="metric-icon green"><LockKeyhole size={20} /></span>
        <h2>{!authReady ? t('جارٍ التحميل…', 'Loading…') : configured ? t('تسجيل الدخول', 'Sign in') : t('مساحة عمل خاصة', 'Private workspace')}</h2>
        {authReady && (configured ? <>
          <p>{t('سجّل الدخول إلى حساب فرع جدة.', 'Sign in to the Jeddah workspace.')}</p>
          <form className="login-form" onSubmit={signIn}>
            <label className="field"><span>{t('البريد الإلكتروني', 'Email address')}</span><input type="email" dir="ltr" name="email" autoComplete="username" required /></label>
            <label className="field"><span>{t('كلمة المرور', 'Password')}</span><input type="password" dir="ltr" name="password" autoComplete="current-password" required /></label>
            <button className="btn primary" disabled={busy}>{busy ? t('جارٍ الدخول…', 'Signing in…') : t('دخول', 'Sign in')}</button>
          </form>
        </> : <p>{t('مساحة العمل بانتظار تفعيل تسجيل الدخول.', 'Sign-in setup is required to open this workspace.')}</p>)}
        {error && <p className="error-box" role="alert">{error}</p>}
      </section>
    </div>
  </main>;

  const current = navigation.find(page => page.id === section)!;
  const entries = [...data.entries].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const currentEntries = activeEntries(entries);
  const ready = loadedFor === userId;
  const action = section === 'shipments' ? t('حاوية جديدة', 'New container') :
    section === 'purchases' || section === 'receipts' ? t('إضافة فاتورة', 'Add invoice') : section === 'debts' ? t('إضافة دين', 'Add debt') : t('عملية جديدة', 'New transaction');
  function openEditor() {
    if (section === 'shipments') setEditor({ type: 'container' });
    else if (section === 'debts') setEditor({ type: 'debt' });
    else if (section === 'purchases' || section === 'receipts') setEditor({ type: 'purchase' });
    else setEditor({ type: 'entry', kind: 'expense' });
  }

  return <div className="workspace">
    {menu && <button className="sidebar-overlay no-print" aria-label={t('إغلاق القائمة', 'Close navigation')} onClick={() => setMenu(false)} />}
    <aside className={'sidebar no-print' + (menu ? ' sidebar-open' : '')}>
      <Brand />
      <div className="branch"><span className="branch-icon"><MapPin size={17} /></span><div><strong>{t('فرع جدة', 'Jeddah branch')}</strong><small>{t('مساحة العمليات', 'Operations workspace')}</small></div></div>
      <p className="nav-label">{t('مساحة العمل', 'WORKSPACE')}</p>
      <nav aria-label={t('القائمة الرئيسية', 'Main navigation')}>{navigation.map(({ id, labels, icon: Icon }) => <button key={id} className={id === section ? 'nav-active' : ''} aria-current={id === section ? 'page' : undefined} onClick={() => navigate(id)}>
        <Icon size={18} strokeWidth={1.8} /><span>{t(labels[0], labels[1])}</span>
      </button>)}</nav>
      <div className="sidebar-bottom">
        <div className="workspace-state"><span />{t('مساحة عمل خاصة', 'Private workspace')}</div>
        <button className="btn sidebar-exit" disabled={busy} onClick={exitWorkspace}><LogOut size={17} />{t('تسجيل الخروج', 'Sign out')}</button>
      </div>
    </aside>
    <div className="app-content">
      <header className="topbar no-print">
        <div className="breadcrumb"><button className="icon-btn mobile-menu" onClick={() => setMenu(!menu)} aria-label={t('القائمة', 'Menu')} aria-expanded={menu}>{menu ? <X size={20} /> : <Menu size={20} />}</button>
          <span>{t('مساحة العمل', 'Workspace')}</span><span className="crumb-slash">/</span><strong>{t(current.labels[0], current.labels[1])}</strong></div>
        <div className="actions">{ready && <button className="icon-btn" onClick={() => setRefresh(n => n + 1)} aria-label={t('تحديث البيانات', 'Refresh data')}><RefreshCw size={16} /></button>}{languageButton}</div>
      </header>
      <main className="main-content">
        <div className="page-heading no-print"><div><div className="eyebrow">{t('إدارة عمليات جدة', 'JEDDAH OPERATIONS')}</div><h1>{t(current.labels[0], current.labels[1])}</h1><p>{t(current.description[0], current.description[1])}</p></div>
          {ready && section !== 'reports' && <button className="btn primary" onClick={openEditor}><Plus size={19} />{action}</button>}
        </div>
        {error && <div className="error-box no-print" role="alert">{error}{!ready && <button className="btn secondary" onClick={() => setRefresh(n => n + 1)}>{t('إعادة المحاولة', 'Retry')}</button>}</div>}
        {!ready && !error && <p role="status" className="panel empty">{t('جارٍ تحميل السجلات…', 'Loading records…')}</p>}
        {ready && <>
          {section === 'overview' && <Dashboard data={data} entries={currentEntries} lang={lang} navigate={navigate} onReceipt={receipt} edit={setEditor} />}
          {(section === 'ledger' || section === 'purchases' || section === 'receipts') && <Ledger key={section} entries={entries} lang={lang} kind={section === 'purchases' ? 'purchase' : section === 'receipts' ? 'receipts' : undefined} onReceipt={receipt} edit={setEditor} />}
          {section === 'debts' && <Debts entries={currentEntries} lang={lang} edit={setEditor} />}
          {section === 'shipments' && <Shipments data={data} lang={lang} edit={setEditor} advance={changeStatus} updating={updating} />}
          {section === 'reports' && <Reports data={data} lang={lang} />}
        </>}
        <footer className="app-footer no-print"><span>ALSINDBAD</span><span>{t('فرع جدة · مساحة العمليات', 'Jeddah branch · Operations workspace')}</span></footer>
      </main>
    </div>
    {notice && <div className="toast no-print" role="status">{notice}</div>}
    {editor && ready && (editor.type === 'purchase'
      ? <PurchaseEditorDialog editor={editor} data={data} lang={lang} close={() => setEditor(null)} save={record} />
      : editor.type === 'debt' || editor.type === 'settlement'
      ? <DebtEditorDialog editor={editor} data={data} lang={lang} close={() => setEditor(null)} save={record} />
      : <EditorDialog editor={editor} data={data} lang={lang} close={() => setEditor(null)} save={record} onReceipt={receipt} openPurchase={() => setEditor({ type: 'purchase' })} />)}
  </div>;
}
