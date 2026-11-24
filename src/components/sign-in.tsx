'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff, Globe2 } from 'lucide-react';
import type { Lang } from '@/lib/domain';
import { translate } from './forms';

export function SignIn({ lang, ready, configured, busy, error, submit, switchLanguage }: {
  lang: Lang; ready: boolean; configured: boolean; busy: boolean; error: string;
  submit: (event: FormEvent<HTMLFormElement>) => void; switchLanguage: () => void;
}) {
  const t = translate(lang);
  const [showPassword, setShowPassword] = useState(false);

  return <main className="gate" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
    <header className="gate-top">
      <button className="gate-language" type="button" onClick={switchLanguage}><Globe2 size={15} aria-hidden="true" /><span>{t('English', 'العربية')}</span></button>
    </header>
    <div className="gate-lines" aria-hidden="true"><div className="gate-line gate-line-first" /><div className="gate-line gate-line-second" /></div>
    <section className="gate-card" aria-labelledby="sign-in-title">
      <div className="gate-brand"><span className="brand-logo"><img src="/brand/alsindbad-logo.svg" width={721} height={731} alt={t('شعار السندباد', 'ALSINDBAD logo')} /></span></div>
      <div className="gate-entry">
      <h1 id="sign-in-title">{!ready ? t('جارٍ التحميل…', 'Loading…') : configured ? t('تسجيل الدخول', 'Sign in') : t('مساحة عمل خاصة', 'Private workspace')}</h1>
      {ready && (configured ? <form className="login-form" onSubmit={submit} aria-label={t('تسجيل الدخول', 'Sign in')}>
        <label className="field"><span>{t('البريد الإلكتروني', 'Email address')}</span><input type="email" dir="ltr" name="email" autoComplete="username" placeholder="name@example.com" required /></label>
        <label className="field"><span>{t('كلمة المرور', 'Password')}</span><span className="login-password">
          <input type={showPassword ? 'text' : 'password'} name="password" autoComplete="current-password" placeholder="••••••••" required />
          <button className="login-password-toggle" type="button" aria-label={showPassword ? t('إخفاء كلمة المرور', 'Hide password') : t('إظهار كلمة المرور', 'Show password')}
            aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>
            {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        </span></label>
        <button className="btn primary login-submit" type="submit" disabled={busy}><span>{busy ? t('جارٍ الدخول…', 'Signing in…') : t('دخول', 'Sign in')}</span><ArrowLeft size={17} aria-hidden="true" /></button>
      </form> : <p>{t('مساحة العمل بانتظار تفعيل تسجيل الدخول.', 'Sign-in setup is required to open this workspace.')}</p>)}
      {error && <p className="error-box" role="alert">{error}</p>}
      </div>
    </section>
  </main>;
}
