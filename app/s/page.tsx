import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

// Only allow an OG image that is one of OUR OWN public thumbnails. Anything else
// (an arbitrary or third-party URL) is rejected, so a crafted /s?i=<url> link
// can never show someone else's image inside a Quickthumb-branded share card.
// The thumbnails bucket is public by design, so echoing one of its URLs here
// exposes nothing new.
function safeThumb(raw: string | undefined): string | null {
  if (!raw || !SUPABASE_URL) return null;
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/thumbnails/`;
  if (!raw.startsWith(prefix)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

type SearchParams = Promise<{ i?: string | string[] }>;

// A share page exists so a SHARED link previews the user's actual thumbnail (its
// OG image) instead of the generic site card — the viral loop for a visual tool.
// It is noindex (per-thumbnail, not a content page) but still crawlable so the
// X/Facebook OG scrapers can read the card.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const sp = await searchParams;
  const img = safeThumb(Array.isArray(sp.i) ? sp.i[0] : sp.i);
  const t = await getTranslations('share');
  const title = t('ogTitle');
  const description = t('ogDescription');
  return {
    title,
    description,
    alternates: { canonical: '/' },
    robots: { index: false, follow: true },
    openGraph: {
      title,
      description,
      siteName: 'Quickthumb',
      type: 'website',
      images: img ? [{ url: img, width: 1280, height: 720 }] : ['/og-image.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: img ? [img] : ['/og-image.png'],
    },
  };
}

export default async function SharePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const img = safeThumb(Array.isArray(sp.i) ? sp.i[0] : sp.i);
  const t = await getTranslations('share');
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding: '48px 20px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <a
        href="/"
        style={{ color: '#fff', textDecoration: 'none', fontSize: 18, fontWeight: 700, marginBottom: 28 }}
      >
        Quickthumb
      </a>
      <h1 style={{ fontSize: 'clamp(24px, 4vw, 36px)', fontWeight: 800, margin: '0 0 20px', lineHeight: 1.2 }}>
        {t('pageHeadline')}
      </h1>
      {img && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img}
            alt={t('ogTitle')}
            width={1280}
            height={720}
            style={{
              width: '100%',
              maxWidth: 760,
              height: 'auto',
              aspectRatio: '16/9',
              objectFit: 'cover',
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
            }}
          />
        </>
      )}
      <p style={{ fontSize: 16, opacity: 0.75, maxWidth: 520, margin: '24px auto 28px' }}>
        {t('pageSub')}
      </p>
      <a
        href="/"
        style={{
          padding: '14px 28px',
          fontSize: 16,
          fontWeight: 700,
          color: '#0f0c29',
          background: 'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
          borderRadius: 10,
          textDecoration: 'none',
        }}
      >
        {t('pageCta')}
      </a>
    </main>
  );
}
