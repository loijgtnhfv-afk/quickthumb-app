'use client';

import { useEffect, useRef, useState } from 'react';
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

// Concept keys we have localized labels for (concepts.* in messages/*.json).
// Guarding the lookup keeps next-intl from throwing on an unexpected key.
const CONCEPT_LABEL_KEYS = new Set(['face-surprise', 'jp-telop', 'global-clean', 'action']);

// Landing-page example gallery: real, unedited output of the production
// pipeline (generated via scripts/gen-examples.ts). The face in the samples is
// an AI-created FICTIONAL persona — never a real person — so they are
// publishable without likeness concerns.
const EXAMPLES = [
  { key: 'face-surprise', src: '/examples/face-surprise.jpg' },
  { key: 'jp-telop', src: '/examples/jp-telop.jpg' },
  { key: 'global-clean', src: '/examples/global-clean.jpg' },
  { key: 'action', src: '/examples/action.jpg' },
] as const;

function isValidYouTubeUrl(url: string): boolean {
  const patterns = [
    // Allow the m. mobile host too — it's what the YouTube app's share sheet
    // emits, and the server (extractVideoId) already accepts it.
    /^(https?:\/\/)?((www|m)\.)?youtube\.com\/watch\?v=[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtu\.be\/[\w-]{11}/,
    /^(https?:\/\/)?((www|m)\.)?youtube\.com\/shorts\/[\w-]{11}/,
  ];
  return patterns.some((p) => p.test(url.trim()));
}

// Cap the uploaded image so large phone photos (often 6–12MB, and frequently
// rotated via EXIF) don't hit Vercel's ~4.5MB request limit or feed Nano Banana
// Pro a sideways face. We normalize on the client; the server still guards size.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;

// Downscale + bake in EXIF orientation + strip metadata (incl. GPS) by drawing
// through a canvas, then re-encode as JPEG. Falls back to the original file if
// the browser can't decode it (e.g. an exotic format) so the server-side
// type/size checks remain the backstop.
async function prepareImageForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const toBlob = (q: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
    // Step quality down until it fits; faces survive q0.55 fine at this size.
    let blob: Blob | null = null;
    for (const q of [0.85, 0.7, 0.55]) {
      blob = await toBlob(q);
      if (blob && blob.size <= MAX_UPLOAD_BYTES) break;
    }
    if (!blob) return file;
    const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
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
  // Stable storage key sent to /api/generate (re-signed server-side). `personaUrl`
  // above is only the short-lived signed URL for the in-page preview.
  const [personaPath, setPersonaPath] = useState<string | null>(null);
  const [personaUploading, setPersonaUploading] = useState(false);
  const [personaError, setPersonaError] = useState('');
  // Affirmative likeness consent — required before a face photo can be uploaded
  // (right-of-publicity). Gates the file input; also sent to / enforced by the API.
  const [personaConsent, setPersonaConsent] = useState(false);
  const [customText, setCustomText] = useState('');
  // A result thumbnail opened full-size in the lightbox (null = closed). Lets a
  // user judge text legibility at real size before downloading.
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Elapsed seconds while a generation is in flight — drives the staged progress
  // copy + bar below so the ~40-60s wait reads as "working", not "frozen".
  const [loadingElapsed, setLoadingElapsed] = useState(0);
  // Bring the progress/results into view on submit — on mobile they sit below
  // the fold, so without this a tap on "Generate" looks like nothing happened.
  const resultsAnchorRef = useRef<HTMLDivElement>(null);
  // Focus target when the lightbox opens: aria-modal hides the rest of the page
  // from assistive tech, so focus must move INTO the dialog or a screen-reader
  // user is left stranded on content their SR now treats as nonexistent.
  const lightboxCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (status === 'loading') {
      resultsAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [status]);

  // Lightbox: close on Escape and lock background scroll while it's open.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Trigger focus is never moved, so closing restores it for free.
    lightboxCloseRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lightbox]);

  useEffect(() => {
    if (status !== 'loading') {
      setLoadingElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => {
      setLoadingElapsed(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [status]);

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

  // Returning from Stripe Checkout (success_url = /?upgraded=1): the
  // subscription.completed webhook can land a beat AFTER the browser redirect,
  // so the first profile read may still show the old free plan. Re-fetch a few
  // times until Pro appears, then strip the param so a later refresh doesn't
  // re-trigger the poll.
  useEffect(() => {
    if (!user || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('upgraded') !== '1') return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 5 && !cancelled; i++) {
        const { data: p } = await supabase
          .from('profiles')
          .select('plan, generations_used, generations_limit')
          .eq('id', user.id)
          .single();
        if (cancelled) return;
        if (p) setProfile(p as Profile);
        if ((p as Profile | null)?.plan === 'pro') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (cancelled) return;
      params.delete('upgraded');
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setResults([]);
    setStatus('idle');
  };

  // Billing UI only appears once a Stripe price is configured (NEXT_PUBLIC_…).
  const billingOn = !!process.env.NEXT_PUBLIC_STRIPE_PRICE_ID;

  const handleBillingRedirect = async (endpoint: '/api/checkout' | '/api/portal') => {
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      // Map the server error code to a localized string so JA users don't see the
      // raw English fallback. Falls back to the network error if the code is unknown.
      const billingCodeMap: Record<string, string> = {
        billing_unconfigured: 'billing.errorUnconfigured',
        unauthorized: 'billing.errorUnauthorized',
        already_subscribed: 'billing.errorAlreadySubscribed',
        no_subscription: 'billing.errorNoSubscription',
        checkout_failed: 'billing.errorCheckout',
        portal_failed: 'billing.errorPortal',
      };
      const key = data.code ? billingCodeMap[data.code] : undefined;
      setError(key ? t(key) : t('form.errorNetwork'));
    } catch {
      setError(t('form.errorNetwork'));
    }
  };

  const handlePersonaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!personaConsent) {
      setPersonaError(t('persona.consentRequired'));
      e.target.value = '';
      return;
    }
    setPersonaError('');
    setPersonaUploading(true);
    try {
      const prepared = await prepareImageForUpload(file);
      // Even after downscaling, a pathological image could exceed the limit —
      // reject client-side with a clear message instead of a Vercel 413.
      if (prepared.size > MAX_UPLOAD_BYTES) {
        setPersonaError(t('persona.tooLarge'));
        return;
      }
      const fd = new FormData();
      fd.append('file', prepared);
      fd.append('consent', 'true');
      const res = await fetch('/api/upload-persona', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        setPersonaError(
          res.status === 422
            ? t('persona.faceRejected')
            : data.code === 'too_large'
            ? t('persona.tooLarge')
            : data.code === 'consent'
            ? t('persona.consentRequired')
            : data.code === 'rate_limited'
            ? t('persona.rateLimited')
            : data.error || t('persona.uploadError')
        );
        return;
      }
      setPersonaUrl(data.url);
      setPersonaPath(data.path);
    } catch {
      setPersonaError(t('persona.uploadError'));
    } finally {
      setPersonaUploading(false);
      // Allow re-selecting the same file again later.
      e.target.value = '';
    }
  };

  // "Remove" the uploaded face. Clear the UI immediately, then delete the stored
  // object best-effort so the photo doesn't linger in storage (and so the
  // privacy-policy "remove at any time" promise is real).
  const handleRemovePersona = async () => {
    const path = personaPath;
    setPersonaUrl(null);
    setPersonaPath(null);
    setPersonaError('');
    if (!path) return;
    try {
      await fetch('/api/upload-persona', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
    } catch {
      // Best-effort: a later upload also deletes older personas server-side.
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
          persona_path: personaPath,
          custom_text: customText.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402) {
          setError(t('form.errorOverLimit', { limit: data.limit }));
        } else if (res.status === 429) {
          setError(t('form.errorBusy'));
        } else {
          // The API returns a stable `code` on every error; map it to a localized
          // string so JA users never see a raw English server message.
          const codeMap: Record<string, string> = {
            video_not_found: 'form.errorVideoNotFound',
            gen_failed: 'form.errorGenerationFailed',
            persona_load: 'form.errorPersonaLoad',
            persona_invalid: 'form.errorPersonaInvalid',
            invalid_url: 'form.errorInvalid',
            empty: 'form.errorEmpty',
            server: 'form.errorServer',
          };
          const key = data.code ? codeMap[data.code] : undefined;
          setError(key ? t(key) : t('form.errorServer'));
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

  // Force a real file download. Our thumbnails live on Supabase storage, and a
  // browser IGNORES the `download` attribute (filename + save) on a cross-origin
  // <a>, so the old link just opened the image in a new tab. Fetch the bytes and
  // download via a same-origin object URL instead. Fall back to opening the URL
  // if the fetch is CORS-blocked or times out — never worse than the old path.
  const handleDownload = async (downloadUrl: string, filename: string) => {
    try {
      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch {
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    }
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

  // Staged feedback for the in-flight generation. The client can't see real
  // backend progress, so advance through reassuring stages on a timer keyed to
  // typical latency; the bar eases toward (but never reaches) 100% until done.
  const loadingStage =
    loadingElapsed < 7 ? 0 : loadingElapsed < 20 ? 1 : loadingElapsed < 40 ? 2 : 3;
  const loadingProgress = Math.min(95, Math.round((loadingElapsed / 55) * 100));

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
                {profile?.plan === 'pro' ? (
                  <button
                    onClick={() => handleBillingRedirect('/api/portal')}
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
                    {t('pricing.manage')}
                  </button>
                ) : billingOn ? (
                  <button
                    onClick={() => handleBillingRedirect('/api/checkout')}
                    style={{
                      padding: '6px 14px',
                      fontSize: 13,
                      fontWeight: 600,
                      color: '#0f0c29',
                      background: 'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
                      border: 'none',
                      borderRadius: 8,
                      cursor: 'pointer',
                    }}
                  >
                    {t('pricing.upgrade')}
                  </button>
                ) : null}
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

        {/* How it works — 3 steps (first-timer clarity) */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            justifyContent: 'center',
            flexWrap: 'wrap',
            marginBottom: 28,
          }}
        >
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 16px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12,
                flex: '1 1 200px',
                maxWidth: 280,
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
                  color: '#0f0c29',
                  fontWeight: 700,
                  fontSize: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {n}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{t(`howto.step${n}Title`)}</div>
                <div style={{ fontSize: 12, opacity: 0.6 }}>{t(`howto.step${n}Body`)}</div>
              </div>
            </div>
          ))}
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
              role="alert"
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
                  alt={t('persona.photoAlt')}
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
                  cursor: personaUploading ? 'wait' : personaConsent ? 'pointer' : 'not-allowed',
                  opacity: personaUploading || !personaConsent ? 0.5 : 1,
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
                  disabled={personaUploading || !personaConsent}
                  style={{ display: 'none' }}
                />
              </label>
              {personaUrl && !personaUploading && (
                <button
                  type="button"
                  onClick={handleRemovePersona}
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
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 11,
                opacity: 0.75,
                marginTop: 12,
                cursor: 'pointer',
                lineHeight: 1.5,
              }}
            >
              <input
                type="checkbox"
                checked={personaConsent}
                onChange={(e) => setPersonaConsent(e.target.checked)}
                style={{ marginTop: 2, accentColor: '#a78bfa', flexShrink: 0 }}
              />
              <span>{t('persona.consentCheck')}</span>
            </label>
            {/* Links live OUTSIDE the <label> so opening a policy doesn't toggle consent */}
            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 6 }}>
              <a
                href="/terms.html"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#c4b5fd', textDecoration: 'underline' }}
              >
                {t('footer.terms')}
              </a>
              {' · '}
              <a
                href="/privacy.html"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#c4b5fd', textDecoration: 'underline' }}
              >
                {t('footer.privacy')}
              </a>
            </div>
            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 8 }}>{t('persona.consent')}</div>
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

        <div ref={resultsAnchorRef} />

        {status === 'loading' && (
          <div>
            <div role="status" aria-live="polite" style={{ textAlign: 'center', marginBottom: 18 }}>
              <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{t(`loading.stage${loadingStage}`)}</p>
              <p style={{ fontSize: 13, opacity: 0.6, margin: '6px 0 0' }}>{t('loading.estimate')}</p>
              <div
                style={{
                  maxWidth: 320,
                  height: 4,
                  margin: '14px auto 0',
                  background: 'rgba(255,255,255,0.12)',
                  borderRadius: 999,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${loadingProgress}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #a78bfa, #f0abfc)',
                    borderRadius: 999,
                    transition: 'width 0.5s ease',
                  }}
                />
              </div>
            </div>
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
                  {/* No aria-label: it would mask the img alt, leaving identical
                      "view larger" names — the alt names the button instead. */}
                  <button
                    type="button"
                    onClick={() => setLightbox(thumb.url)}
                    title={t('results.enlarge')}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: 0,
                      border: 'none',
                      background: 'none',
                      cursor: 'zoom-in',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumb.url}
                      alt={
                        thumb.concept_key && CONCEPT_LABEL_KEYS.has(thumb.concept_key)
                          ? t('results.alt', { label: t(`concepts.${thumb.concept_key}`) })
                          : t('results.altPlain')
                      }
                      style={{ width: '100%', display: 'block', aspectRatio: '16/9', objectFit: 'cover' }}
                    />
                  </button>
                  <div style={{ padding: 14 }}>
                    {thumb.concept_key && CONCEPT_LABEL_KEYS.has(thumb.concept_key) && (
                      <p
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          opacity: 0.6,
                          margin: '0 0 10px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                        }}
                      >
                        {t(`concepts.${thumb.concept_key}`)}
                      </p>
                    )}
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

        {/* Example gallery — lets a signed-out visitor judge output quality
            before signing up. Hidden while a generation is in flight or its
            results are showing, so it never competes with the user's own. */}
        {status !== 'loading' && status !== 'success' && (
          <section aria-labelledby="examples-heading" style={{ marginTop: 8 }}>
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <h2 id="examples-heading" style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>
                {t('examples.heading')}
              </h2>
              <p style={{ fontSize: 14, opacity: 0.65, maxWidth: 600, margin: '8px auto 0' }}>
                {t('examples.subtitle')}
              </p>
            </div>
            <div className="thumb-row">
              {EXAMPLES.map((ex) => (
                <figure key={ex.key} style={{ margin: 0, minWidth: 0 }}>
                  {/* No aria-label: the img alt (concept-specific) names the button. */}
                  <button
                    type="button"
                    onClick={() => setLightbox(ex.src)}
                    title={t('results.enlarge')}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: 0,
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 12,
                      overflow: 'hidden',
                      background: 'none',
                      cursor: 'zoom-in',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={ex.src}
                      alt={t('examples.alt', { label: t(`concepts.${ex.key}`) })}
                      loading="lazy"
                      width={1280}
                      height={720}
                      style={{
                        width: '100%',
                        height: 'auto',
                        display: 'block',
                        aspectRatio: '16/9',
                        objectFit: 'cover',
                      }}
                    />
                  </button>
                  <figcaption
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      opacity: 0.6,
                      margin: '8px 2px 0',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {t(`concepts.${ex.key}`)}
                  </figcaption>
                </figure>
              ))}
            </div>
            {/* opacity >= 0.6 keeps this disclosure above the 4.5:1 AA contrast
                minimum over the page gradient — it carries the honesty/legal
                note, so it must stay readable. */}
            <p style={{ fontSize: 11, opacity: 0.6, textAlign: 'center', marginTop: 12 }}>
              {t('examples.note')}
            </p>
          </section>
        )}

        <footer style={{ textAlign: 'center', marginTop: 64, fontSize: 13, opacity: 0.5 }}>
          {t('footer.copyright')} ·{' '}
          <a href="/terms.html" style={{ color: 'inherit' }}>{t('footer.terms')}</a> ·{' '}
          <a href="/privacy.html" style={{ color: 'inherit' }}>{t('footer.privacy')}</a>
          {billingOn && (
            <>
              {' · '}
              <a href="/tokushoho.html" style={{ color: 'inherit' }}>{t('footer.tokushoho')}</a>
            </>
          )}
        </footer>
      </div>

      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('results.preview')}
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => {
            // The close button is the dialog's only focusable element — pin
            // Tab there so keyboard focus can't escape the open modal.
            if (e.key === 'Tab') e.preventDefault();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 50,
            cursor: 'zoom-out',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt={t('results.preview')}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              borderRadius: 12,
              boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
            }}
          />
          <button
            type="button"
            ref={lightboxCloseRef}
            onClick={() => setLightbox(null)}
            aria-label={t('results.closePreview')}
            style={{
              position: 'absolute',
              top: 16,
              right: 20,
              fontSize: 32,
              lineHeight: 1,
              color: '#fff',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
      )}

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
