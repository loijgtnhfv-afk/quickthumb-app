'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import type { User } from '@supabase/supabase-js';

type Status = 'idle' | 'loading' | 'success' | 'error';

interface Thumbnail {
  id: number;
  url: string;
  image_url: string;
  prompt: string;
  concept_key?: string;
}

interface Profile {
  plan: 'free' | 'pro';
  generations_used: number;
  generations_limit: number;
}

function isValidYouTubeUrl(url: string): boolean {
  const patterns = [
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtu\.be\/[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
  ];
  return patterns.some((p) => p.test(url.trim()));
}

// Tiny header toggle to switch between EN and JA. Persists via cookie so the
// next request hits next-intl's request config with the correct locale.
function LangSwitcher({ current }: { current: string }) {
  const t = useTranslations('language');
  const [busy, setBusy] = useState(false);
  const handleSwitch = async (next: 'en' | 'ja') => {
    if (next === current || busy) return;
    setBusy(true);
    try {
      await fetch('/api/locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
      // Hard reload so the server layout re-renders with the new locale.
      window.location.reload();
    } catch {
      setBusy(false);
    }
  };
  return (
    <div
      title={t('switchLabel')}
      style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 }}
    >
      {(['en', 'ja'] as const).map((loc) => {
        const active = loc === current;
        return (
          <button
            key={loc}
            type="button"
            onClick={() => handleSwitch(loc)}
            disabled={busy || active}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 600,
              color: active ? '#0f0c29' : '#fff',
              background: active
                ? 'rgba(255,255,255,0.9)'
                : 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.18)',
              borderRadius: 999,
              cursor: active ? 'default' : busy ? 'wait' : 'pointer',
              opacity: busy && !active ? 0.5 : 1,
            }}
          >
            {loc === 'en' ? 'EN' : 'JA'}
          </button>
        );
      })}
    </div>
  );
}

export default function Home() {
  const supabase = createClient();
  const locale = useLocale();
  const t = useTranslations();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [results, setResults] = useState<Thumbnail[]>([]);
  // The user's own uploaded face photo (persona). When set, NBP makes it the
  // hero of every thumbnail; when null, thumbnails are generated faceless.
  const [personaUrl, setPersonaUrl] = useState<string | null>(null);
  const [personaUploading, setPersonaUploading] = useState(false);
  const [personaError, setPersonaError] = useState('');
  const [customText, setCustomText] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;
      setUser(data.user);
      if (data.user) {
        const { data: p } = await supabase
          .from('profiles')
          .select('plan, generations_used, generations_limit')
          .eq('id', data.user.id)
          .single();
        if (mounted) setProfile(p as Profile | null);
      }
      setAuthLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (!session?.user) setProfile(null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setResults([]);
    setStatus('idle');
  };

  const handlePersonaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPersonaError('');
    setPersonaUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload-persona', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        setPersonaError(data.error || t('persona.uploadError'));
        return;
      }
      setPersonaUrl(data.url);
    } catch {
      setPersonaError(t('persona.uploadError'));
    } finally {
      setPersonaUploading(false);
      // Allow re-selecting the same file again later.
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!user) {
      window.location.href = '/auth?mode=signup';
      return;
    }
    if (!url.trim()) {
      setError(t('form.errorEmpty'));
      return;
    }
    if (!isValidYouTubeUrl(url)) {
      setError(t('form.errorInvalid'));
      return;
    }

    setStatus('loading');

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          youtube_url: url,
          persona_url: personaUrl,
          custom_text: customText.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402) {
          setError(t('form.errorOverLimit', { limit: data.limit }));
        } else {
          setError(data.error || t('form.errorNetwork'));
        }
        setStatus('error');
        return;
      }
      setResults(data.thumbnails as Thumbnail[]);
      setProfile((prev) =>
        prev
          ? { ...prev, generations_used: data.generations_used }
          : { plan: 'free', generations_used: data.generations_used, generations_limit: data.generations_limit }
      );
      setStatus('success');
    } catch {
      setError(t('form.errorNetwork'));
      setStatus('error');
    }
  };

  const handleDownload = (downloadUrl: string, filename: string) => {
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // "Generate again" — keep the uploaded persona so the user doesn't re-upload.
  const handleReset = () => {
    setUrl('');
    setStatus('idle');
    setResults([]);
    setError('');
    setCustomText('');
  };

  const remaining = profile ? Math.max(0, profile.generations_limit - profile.generations_used) : null;

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding: '32px 20px 48px',
      }}
    >
      <div style={{ maxWidth: 1500, margin: '0 auto' }}>
        {/* Header */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
          <a href="/" style={{ color: '#fff', textDecoration: 'none', fontSize: 18, fontWeight: 700 }}>
            {t('nav.brand')}
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14 }}>
            <LangSwitcher current={locale} />
            {authLoading ? null : user ? (
              <>
                {remaining !== null && (
                  <span style={{ opacity: 0.7 }}>
                    {t('nav.remaining', { count: remaining, limit: profile!.generations_limit })}
                  </span>
                )}
                <span style={{ opacity: 0.85, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.email}
                </span>
                <button
                  onClick={handleSignOut}
                  style={{
                    padding: '6px 12px',
                    fontSize: 13,
                    background: 'transparent',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.25)',
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                >
                  {t('nav.signOut')}
                </button>
              </>
            ) : (
              <>
                <a href="/auth" style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none' }}>
                  {t('nav.signIn')}
                </a>
                <a
                  href="/auth?mode=signup"
                  style={{
                    padding: '6px 14px',
                    background: 'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
                    color: '#0f0c29',
                    fontWeight: 600,
                    textDecoration: 'none',
                    borderRadius: 8,
                  }}
                >
                  {t('nav.signUp')}
                </a>
              </>
            )}
          </div>
        </header>

        {/* Hero */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div
            style={{
              display: 'inline-block',
              padding: '4px 12px',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 999,
              fontSize: 12,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 16,
            }}
          >
            {t('hero.beta')}
          </div>
          <h1
            style={{
              fontSize: 'clamp(36px, 6vw, 64px)',
              fontWeight: 800,
              margin: 0,
              lineHeight: 1.1,
              background: 'linear-gradient(135deg, #ffffff 0%, #a78bfa 50%, #f0abfc 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            {t('hero.titleLine1')}<br />{t('hero.titleLine2')}
          </h1>
          <p style={{ fontSize: 18, opacity: 0.75, maxWidth: 600, margin: '20px auto 0' }}>
            {t('hero.subtitle')}
          </p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 16,
            padding: 24,
            backdropFilter: 'blur(20px)',
            marginBottom: 32,
          }}
        >
          <label
            htmlFor="youtube-url"
            style={{ display: 'block', fontSize: 14, opacity: 0.85, marginBottom: 10, fontWeight: 500 }}
          >
            {t('form.urlLabel')}
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <input
              id="youtube-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('form.urlPlaceholder')}
              disabled={status === 'loading'}
              style={{
                flex: '1 1 320px',
                padding: '14px 16px',
                fontSize: 16,
                background: 'rgba(0,0,0,0.35)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 10,
                color: '#fff',
                outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={status === 'loading'}
              style={{
                padding: '14px 28px',
                fontSize: 16,
                fontWeight: 600,
                color: '#0f0c29',
                background:
                  status === 'loading'
                    ? 'rgba(255,255,255,0.4)'
                    : 'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
                border: 'none',
                borderRadius: 10,
                cursor: status === 'loading' ? 'wait' : 'pointer',
                minWidth: 160,
                transition: 'transform 0.15s ease',
              }}
            >
              {status === 'loading'
                ? t('form.submitting')
                : user
                ? t('form.submitGenerate')
                : t('form.submitSignup')}
            </button>
          </div>
          {error && (
            <div
              style={{
                marginTop: 14,
                padding: '10px 14px',
                background: 'rgba(248, 113, 113, 0.15)',
                border: '1px solid rgba(248, 113, 113, 0.4)',
                borderRadius: 8,
                fontSize: 14,
                color: '#fecaca',
              }}
            >
              {error}
            </div>
          )}

          {/* Persona (your own face) uploader */}
          <div
            style={{
              marginTop: 14,
              padding: '14px',
              background: 'rgba(255,255,255,0.05)',
              border: personaUrl
                ? '1px solid rgba(167,139,250,0.6)'
                : '1px solid rgba(255,255,255,0.15)',
              borderRadius: 10,
              transition: 'border-color 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {personaUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={personaUrl}
                  alt="Your face"
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    objectFit: 'cover',
                    border: '1px solid rgba(255,255,255,0.25)',
                  }}
                />
              ) : (
                <div
                  aria-hidden
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px dashed rgba(255,255,255,0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 20,
                    opacity: 0.6,
                  }}
                >
                  🙂
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{t('persona.label')}</span>
                <span style={{ fontSize: 12, opacity: 0.6 }}>{t('persona.hint')}</span>
              </div>
              <label
                style={{
                  padding: '8px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#0f0c29',
                  background: 'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
                  borderRadius: 999,
                  cursor: personaUploading ? 'wait' : 'pointer',
                  opacity: personaUploading ? 0.6 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {personaUploading
                  ? t('persona.uploading')
                  : personaUrl
                  ? t('persona.change')
                  : t('persona.upload')}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handlePersonaUpload}
                  disabled={personaUploading}
                  style={{ display: 'none' }}
                />
              </label>
              {personaUrl && !personaUploading && (
                <button
                  type="button"
                  onClick={() => setPersonaUrl(null)}
                  style={{
                    padding: '8px 12px',
                    fontSize: 13,
                    background: 'transparent',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.25)',
                    borderRadius: 999,
                    cursor: 'pointer',
                  }}
                >
                  {t('persona.remove')}
                </button>
              )}
            </div>
            {personaError && (
              <div style={{ marginTop: 10, fontSize: 13, color: '#fecaca' }}>{personaError}</div>
            )}
            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>{t('persona.consent')}</div>
          </div>

          <div style={{ marginTop: 14 }}>
            <label
              htmlFor="custom-text"
              style={{
                display: 'block',
                fontSize: 13,
                opacity: 0.7,
                marginBottom: 6,
                fontWeight: 500,
              }}
            >
              {t('caption.label')}<span style={{ opacity: 0.5, fontWeight: 400 }}>{t('caption.hint')}</span>
            </label>
            <input
              id="custom-text"
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              maxLength={60}
              placeholder={t('caption.placeholder')}
              disabled={status === 'loading'}
              style={{
                width: '100%',
                padding: '10px 14px',
                fontSize: 14,
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 10,
                color: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <p style={{ fontSize: 13, opacity: 0.55, marginTop: 14, marginBottom: 0 }}>
            {t('form.urlHint')}
          </p>
        </form>

        {status === 'loading' && (
          <div className="thumb-row">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  aspectRatio: '16/9',
                  background:
                    'linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.04) 100%)',
                  backgroundSize: '200% 100%',
                  borderRadius: 12,
                  animation: 'shimmer 1.5s infinite linear',
                }}
              />
            ))}
          </div>
        )}

        {status === 'success' && results.length > 0 && (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <h2 style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>
                {t('results.heading', { count: results.length })}
              </h2>
              <button
                onClick={handleReset}
                style={{
                  padding: '8px 16px',
                  fontSize: 14,
                  background: 'transparent',
                  color: '#fff',
                  border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
              >
                {t('results.regenerate')}
              </button>
            </div>
            <div className="thumb-row">
              {results.map((thumb) => (
                <div
                  key={thumb.id}
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 12,
                    overflow: 'hidden',
                    minWidth: 0,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumb.url}
                    alt={`Thumbnail option ${thumb.id}`}
                    style={{ width: '100%', display: 'block', aspectRatio: '16/9', objectFit: 'cover' }}
                  />
                  <div style={{ padding: 14 }}>
                    <button
                      onClick={() => handleDownload(thumb.url, `quickthumb-${thumb.id}.png`)}
                      style={{
                        width: '100%',
                        padding: '10px 14px',
                        fontSize: 14,
                        fontWeight: 600,
                        color: '#0f0c29',
                        background: '#fff',
                        border: 'none',
                        borderRadius: 8,
                        cursor: 'pointer',
                      }}
                    >
                      {t('results.download')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <footer style={{ textAlign: 'center', marginTop: 64, fontSize: 13, opacity: 0.5 }}>
          {t('footer.copyright')} ·{' '}
          <a href="/terms.html" style={{ color: 'inherit' }}>{t('footer.terms')}</a> ·{' '}
          <a href="/privacy.html" style={{ color: 'inherit' }}>{t('footer.privacy')}</a>
        </footer>
      </div>

      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        input::placeholder { color: rgba(255,255,255,0.4); }
        button:not(:disabled):hover { transform: translateY(-1px); }
        .thumb-row {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 14px;
        }
        @media (max-width: 900px) {
          .thumb-row {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 16px;
          }
        }
        @media (max-width: 520px) {
          .thumb-row {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}
