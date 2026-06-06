'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';

type Mode = 'signin' | 'signup';

function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode: Mode = searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
  const t = useTranslations();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // A failed confirmation-link exchange redirects here with ?error=callback_failed
  // (see app/auth/callback/route.ts). Surface it instead of landing on a silent
  // sign-in page. Lazy initializer so we read the param once, without a render effect.
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    () =>
      searchParams.get('error') === 'callback_failed'
        ? { type: 'error', text: t('auth.somethingWrong') }
        : null
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setLoading(true);

    const supabase = createClient();

    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (error) throw error;
        setMessage({ type: 'success', text: t('auth.checkInbox') });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push('/');
        router.refresh();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('auth.somethingWrong');
      setMessage({ type: 'error', text: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ width: '100%', maxWidth: 420 }}>
      <a
        href="/"
        style={{
          display: 'inline-block',
          color: 'rgba(255,255,255,0.6)',
          textDecoration: 'none',
          fontSize: 14,
          marginBottom: 24,
        }}
      >
        {t('auth.backToHome')}
      </a>
      <div
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 16,
          padding: 32,
          backdropFilter: 'blur(20px)',
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 8px' }}>
          {mode === 'signup' ? t('auth.signupTitle') : t('auth.signinTitle')}
        </h1>
        <p style={{ fontSize: 14, opacity: 0.7, margin: '0 0 24px' }}>
          {mode === 'signup' ? t('auth.signupSubtitle') : t('auth.signinSubtitle')}
        </p>

        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', fontSize: 13, opacity: 0.85, marginBottom: 6 }}>
            {t('auth.emailLabel')}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px 14px',
              marginBottom: 16,
              fontSize: 15,
              background: 'rgba(0,0,0,0.35)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 10,
              color: '#fff',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />

          <label style={{ display: 'block', fontSize: 13, opacity: 0.85, marginBottom: 6 }}>
            {t('auth.passwordLabel')}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px 14px',
              marginBottom: 20,
              fontSize: 15,
              background: 'rgba(0,0,0,0.35)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 10,
              color: '#fff',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px 16px',
              fontSize: 15,
              fontWeight: 600,
              color: '#0f0c29',
              background: loading
                ? 'rgba(255,255,255,0.4)'
                : 'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
              border: 'none',
              borderRadius: 10,
              cursor: loading ? 'wait' : 'pointer',
            }}
          >
            {loading
              ? t('auth.submitting')
              : mode === 'signup'
              ? t('auth.submitSignup')
              : t('auth.submitSignin')}
          </button>
        </form>

        {message && (
          <div
            style={{
              marginTop: 16,
              padding: '10px 14px',
              background:
                message.type === 'error'
                  ? 'rgba(248,113,113,0.15)'
                  : 'rgba(74,222,128,0.15)',
              border:
                message.type === 'error'
                  ? '1px solid rgba(248,113,113,0.4)'
                  : '1px solid rgba(74,222,128,0.4)',
              borderRadius: 8,
              fontSize: 13,
              color: message.type === 'error' ? '#fecaca' : '#bbf7d0',
            }}
          >
            {message.text}
          </div>
        )}

        <div
          style={{
            marginTop: 24,
            paddingTop: 20,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            fontSize: 14,
            opacity: 0.7,
            textAlign: 'center',
          }}
        >
          {mode === 'signup' ? t('auth.alreadyHaveAccount') : t('auth.noAccount')}{' '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signup' ? 'signin' : 'signup');
              setMessage(null);
            }}
            style={{
              background: 'none',
              border: 'none',
              color: '#f0abfc',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              padding: 0,
            }}
          >
            {mode === 'signup' ? t('auth.switchToSignin') : t('auth.switchToSignup')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AuthPage() {
  const t = useTranslations('common');
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
        color: '#fff',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <Suspense fallback={<div style={{ color: '#fff' }}>{t('loading')}</div>}>
        <AuthForm />
      </Suspense>
    </main>
  );
}
