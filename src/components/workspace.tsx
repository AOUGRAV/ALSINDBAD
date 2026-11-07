'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Anchor, ArrowUpRight, ChartNoAxesCombined, CircleDollarSign, ClipboardList, Globe2, LayoutDashboard, LockKeyhole, LogOut, MapPin, Menu, Package, Plus, ReceiptText, RefreshCw, Ship, ShoppingBag, X } from 'lucide-react';
import { emptyData, type Container, type Dataset, type Lang } from '@/lib/domain';
import { demoData } from '@/lib/demo';
import { advanceContainer, configured, downloadReceipt, loadData, saveContainer, saveEntry, saveLoad, saveProduct, supabase, uploadReceipt } from '@/lib/storage';
import { EditorDialog, errorMessage, translate, type Editor, type RecordChange } from './forms';
import { Dashboard, Debts, Inventory, Ledger, Shipments } from './views';
import { Reports } from './reports';

const navigation = [
  { id: 'overview', labels: ['نظرة عامة', 'Overview'], description: ['ملخص حسابات ومشتريات فرع جدة في مكان واحد.', 'Your Jeddah accounts and operations in one place.'], icon: LayoutDashboard },
  { id: 'ledger', labels: ['الحركات المالية', 'Transactions'], description: ['تتبع التمويل والمصاريف والأصول وحركة النقد.', 'Track funding, expenses, assets, and cash movement.'], icon: ClipboardList },
  { id: 'purchases', labels: ['المشتريات', 'Purchases'], description: ['سجّل مشتريات الموردين وتابع المدفوع والمتبقي.', 'Record supplier purchases and track amounts paid and outstanding.'], icon: ShoppingBag },
  { id: 'debts', labels: ['الديون والسلف', 'Debts and advances'], description: ['تابع ما لنا وما علينا بالعملة الأصلية وسجّل دفعات السداد.', 'Track balances in their original currencies and record settlements.'], icon: CircleDollarSign },
  { id: 'inventory', labels: ['المخزون', 'Inventory'], description: ['تابع الأصناف والكميات المشتراة والمحملة والمتبقية.', 'Track products and quantities purchased, loaded, and in stock.'], icon: Package },
  { id: 'shipments', labels: ['الحاويات والشحن', 'Containers'], description: ['أدر تحميل البضائع وتابع تكاليف الحاويات والشحن.', 'Manage stock loading and track container and shipping costs.'], icon: Ship },
  { id: 'receipts', labels: ['الفواتير', 'Receipts'], description: ['استعرض الفواتير والإيصالات المرفقة بالحركات.', 'Find invoices and receipts attached to transactions.'], icon: ReceiptText },
  { id: 'reports', labels: ['التقارير', 'Reports'], description: ['صفِّ البيانات وصدّر تقارير فرع جدة إلى Excel أو PDF.', 'Filter Jeddah records and export reports to Excel or PDF.'], icon: ChartNoAxesCombined },
] as const;
type Section = typeof navigation[number]['id'];
const demoKey = 'alsindbad.demo.v1';
const languageKey = 'alsindbad.language';

function Brand() {
  return <div className="brand"><span className="brand-mark"><Anchor size={25} strokeWidth={1.8} /></span><div><strong>السندباد</strong><small>ALSINDBAD</small></div></div>;
}

export default function Workspace() {
  const [lang, setLang] = useState<Lang>('ar');
  const [userId, setUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(!configured);
  const [demo, setDemo] = useState(false);
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
    setLoadedFor(null);
    setError('');
    loadData().then(result => {
      if (active) { setData(result); setLoadedFor(userId); }
    }).catch(problem => { if (active) setError(errorMessage(problem)); });
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
  function startDemo() {
    setError('');
    try {
      const saved = localStorage.getItem(demoKey);
      setData(saved ? JSON.parse(saved) as Dataset : demoData());
      setDemo(true);
    } catch (problem) { setError(errorMessage(problem)); }
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
      if (configured) {
        const { error: problem } = await supabase().auth.signOut({ scope: 'local' });
        if (problem) throw problem;
      }
      setData(emptyData());
      setLoadedFor(null);
      setSection('overview');
      setEditor(null);
      setDemo(false);
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
  function updateData(next: Dataset) {
    if (demo) localStorage.setItem(demoKey, JSON.stringify(next));
    setData(next);
  }
  async function record(change: RecordChange) {
    if (change.type === 'entry') {
      const entry = change.value;
      if (!demo) {
        if (change.receipt) entry.receipt_path = await uploadReceipt(change.receipt, entry.id);
        await saveEntry(entry);
      }
      updateData({ ...data, entries: [...data.entries, entry] });
    } else if (change.type === 'product') {
      if (!demo) await saveProduct(change.value);
      updateData({ ...data, products: [...data.products, change.value] });
    } else if (change.type === 'container') {
      if (!demo) await saveContainer(change.value);
      updateData({ ...data, containers: [...data.containers, change.value] });
    } else {
      if (!demo) await saveLoad(change.value);
      updateData({ ...data, loads: [...data.loads, change.value] });
    }
    setNotice(t('تم الحفظ بنجاح.', 'Saved successfully.'));
  }
  async function changeStatus(container: Container) {
    if (updating || container.status === 'arrived') return;
    setError('');
    setUpdating(container.id);
    try {
      if (!demo) await advanceContainer(container);
      updateData({ ...data, containers: data.containers.map(c => c.id === container.id ? { ...c, status: c.status === 'preparing' ? 'shipped' : 'arrived' } : c) });
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

  if (!authReady || (!userId && !demo)) return <main className="gate">
    <div className="gate-top"><Brand />{languageButton}</div>
    <div className="gate-grid">
      <section className="gate-art">
        <span className="eyebrow">JEDDAH OPERATIONS / 01</span>
        <div><span className="gate-anchor"><Anchor size={66} strokeWidth={1.2} /></span><h1>{t('عمليات جدة، في مكان واحد.', 'Jeddah operations, in one place.')}</h1><p>{t('الحسابات والمشتريات والمخزون والحاويات، من أول عملية إلى آخر شحنة.', 'Accounts, purchases, stock, and containers from the first transaction to the last shipment.')}</p></div>
        <div className="gate-location"><MapPin size={16} />{t('جدة · المملكة العربية السعودية', 'Jeddah · Saudi Arabia')}</div>
      </section>
      <section className="gate-card">
        <span className="metric-icon green"><LockKeyhole size={20} /></span>
        <h2>{!authReady ? t('جارٍ التحميل…', 'Loading…') : configured ? t('تسجيل الدخول', 'Sign in') : t('جرّب مساحة العمل', 'Explore the workspace')}</h2>
        {authReady && (configured ? <>
          <p>{t('سجّل الدخول إلى حساب فرع جدة.', 'Sign in to the Jeddah workspace.')}</p>
          <form className="login-form" onSubmit={signIn}>
            <label className="field"><span>{t('البريد الإلكتروني', 'Email address')}</span><input type="email" dir="ltr" name="email" autoComplete="username" required /></label>
            <label className="field"><span>{t('كلمة المرور', 'Password')}</span><input type="password" dir="ltr" name="password" autoComplete="current-password" required /></label>
            <button className="btn primary" disabled={busy}>{busy ? t('جارٍ الدخول…', 'Signing in…') : t('دخول', 'Sign in')}</button>
          </form>
        </> : <>
          <p>{t('استعرض السندباد ببيانات افتراضية. تُحفظ تغييرات التجربة في هذا المتصفح.', 'Explore ALSINDBAD with sample data. Demo changes are saved in this browser.')}</p>
          <button className="btn primary" onClick={startDemo}>{t('فتح النسخة التجريبية', 'Open demo')} <ArrowUpRight size={17} /></button>
        </>)}
        {error && <p className="error-box" role="alert">{error}</p>}
      </section>
    </div>
  </main>;

  const current = navigation.find(page => page.id === section)!;
  const entries = [...data.entries].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const ready = demo || loadedFor === userId;
  const action = section === 'inventory' ? t('إضافة صنف', 'Add product') : section === 'shipments' ? t('حاوية جديدة', 'New container') :
    section === 'purchases' ? t('شراء جديد', 'New purchase') : section === 'debts' ? t('إضافة دين', 'Add debt') : t('عملية جديدة', 'New transaction');
  function openEditor() {
    if (section === 'inventory') setEditor({ type: 'product' });
    else if (section === 'shipments') setEditor({ type: 'container' });
    else setEditor({ type: 'entry', kind: section === 'purchases' ? 'purchase' : section === 'debts' ? 'borrow' : 'expense' });
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
        <div className="workspace-state"><span />{demo ? t('بيئة تجريبية', 'Demo workspace') : t('مساحة عمل خاصة', 'Private workspace')}</div>
        <button className="btn sidebar-exit" disabled={busy} onClick={exitWorkspace}><LogOut size={17} />{demo ? t('خروج من التجربة', 'Exit demo') : t('تسجيل الخروج', 'Sign out')}</button>
      </div>
    </aside>
    <div className="app-content">
      <header className="topbar no-print">
        <div className="breadcrumb"><button className="icon-btn mobile-menu" onClick={() => setMenu(!menu)} aria-label={t('القائمة', 'Menu')} aria-expanded={menu}>{menu ? <X size={20} /> : <Menu size={20} />}</button>
          <span>{t('مساحة العمل', 'Workspace')}</span><span className="crumb-slash">/</span><strong>{t(current.labels[0], current.labels[1])}</strong></div>
        <div className="actions">{!demo && ready && <button className="icon-btn" onClick={() => setRefresh(n => n + 1)} aria-label={t('تحديث البيانات', 'Refresh data')}><RefreshCw size={16} /></button>}{languageButton}</div>
      </header>
      <main className="main-content">
        {demo && <div className="demo-banner no-print"><span className="demo-dot" /><strong>{t('نسخة تجريبية', 'Demo mode')}</strong><span>{t('تستخدم بيانات افتراضية محفوظة في هذا المتصفح.', 'Sample records are saved in this browser.')}</span></div>}
        <div className="page-heading no-print"><div><div className="eyebrow">{t('إدارة عمليات جدة', 'JEDDAH OPERATIONS')}</div><h1>{t(current.labels[0], current.labels[1])}</h1><p>{t(current.description[0], current.description[1])}</p></div>
          {ready && section !== 'reports' && <button className="btn primary" onClick={openEditor}><Plus size={19} />{action}</button>}
        </div>
        {error && <div className="error-box no-print" role="alert">{error}{!ready && <button className="btn secondary" onClick={() => setRefresh(n => n + 1)}>{t('إعادة المحاولة', 'Retry')}</button>}</div>}
        {!ready && !error && <p role="status" className="panel empty">{t('جارٍ تحميل السجلات…', 'Loading records…')}</p>}
        {ready && <>
          {section === 'overview' && <Dashboard data={data} entries={entries} lang={lang} navigate={navigate} onReceipt={receipt} />}
          {(section === 'ledger' || section === 'purchases' || section === 'receipts') && <Ledger key={section} entries={entries} lang={lang} kind={section === 'purchases' ? 'purchase' : section === 'receipts' ? 'receipts' : undefined} onReceipt={receipt} />}
          {section === 'debts' && <Debts entries={entries} lang={lang} edit={setEditor} />}
          {section === 'inventory' && <Inventory data={data} lang={lang} />}
          {section === 'shipments' && <Shipments data={data} lang={lang} edit={setEditor} advance={changeStatus} updating={updating} />}
          {section === 'reports' && <Reports data={data} lang={lang} demo={demo} />}
        </>}
        <footer className="app-footer no-print"><span>ALSINDBAD</span><span>{t('فرع جدة · مساحة العمليات', 'Jeddah branch · Operations workspace')}</span></footer>
      </main>
    </div>
    {notice && <div className="toast no-print" role="status">{notice}</div>}
    {editor && ready && <EditorDialog editor={editor} data={data} lang={lang} demo={demo} close={() => setEditor(null)} save={record} />}
  </div>;
}
