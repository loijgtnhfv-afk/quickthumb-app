'use client';

import { useState } from 'react';

type Status = 'idle' | 'loading' | 'success' | 'error';

interface Thumbnail {
  id: number;
  url: string;
  prompt: string;
}

const MOCK_THUMBNAILS: Thumbnail[] = [
  { id: 1, url: 'https://placehold.co/1280x720/667eea/ffffff/png?text=Thumbnail+1', prompt: 'Bold typography, high contrast' },
  { id: 2, url: 'https://placehold.co/1280x720/f093fb/ffffff/png?text=Thumbnail+2', prompt: 'Vibrant gradient, character focus' },
  { id: 3, url: 'https://placehold.co/1280x720/4facfe/ffffff/png?text=Thumbnail+3', prompt: 'Minimalist, single subject' },
  { id: 4, url: 'https://placehold.co/1280x720/fa709a/ffffff/png?text=Thumbnail+4', prompt: 'Dramatic lighting, emotion' },
];

function isValidYouTubeUrl(url: string): boolean {
  const patterns = [
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtu\.be\/[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
  ];
  return patterns.some((p) => p.test(url.trim()));
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [results, setResults] = useState<Thumbnail[]>([]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!url.trim()) {
      setError('Please paste a YouTube URL.');
      return;
    }
    if (!isValidYouTubeUrl(url)) {
      setError('That doesn’t look like a valid YouTube URL. Try https://youtube.com/watch?v=...');
      return;
    }

    setStatus('loading');

    // Mock: simulate 4-second generation (replace with /api/generate later)
    await new Promise((r) => setTimeout(r, 4000));

    setResults(MOCK_THUMBNAILS);
    setStatus('success');
  };

  const handleDownload = (thumb: Thumbnail) => {
    const a = document.createElement('a');
    a.href = thumb.url;
    a.download = `quickthumb-${thumb.id}.png`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleReset = () => {
    setUrl('');
    setStatus('idle');
    setResults([]);
    setError('');
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding: '48px 20px',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 48 }}>
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
            Beta · Free for early users
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
            YouTube thumbnails<br />in 60 seconds.
          </h1>
          <p style={{ fontSize: 18, opacity: 0.75, maxWidth: 600, margin: '20px auto 0' }}>
            Paste any YouTube URL. Get 4 AI-generated thumbnail options instantly.
            5 free · No credit card.
          </p>
        </header>

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
            YouTube URL
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <input
              id="youtube-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
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
                background: status === 'loading'
                  ? 'rgba(255,255,255,0.4)'
                  : 'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
                border: 'none',
                borderRadius: 10,
                cursor: status === 'loading' ? 'wait' : 'pointer',
                minWidth: 160,
                transition: 'transform 0.15s ease',
              }}
            >
              {status === 'loading' ? 'Generating...' : 'Generate'}
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
          <p style={{ fontSize: 13, opacity: 0.55, marginTop: 14, marginBottom: 0 }}>
            Works with youtube.com/watch, youtu.be, and Shorts links.
          </p>
        </form>

        {status === 'loading' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  aspectRatio: '16/9',
                  background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.04) 100%)',
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
              <h2 style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>4 thumbnails ready</h2>
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
                Generate again
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
              {results.map((thumb) => (
                <div
                  key={thumb.id}
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 12,
                    overflow: 'hidden',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumb.url}
                    alt={`Thumbnail option ${thumb.id}`}
                    style={{ width: '100%', display: 'block', aspectRatio: '16/9', objectFit: 'cover' }}
                  />
                  <div style={{ padding: 14 }}>
                    <p style={{ fontSize: 13, opacity: 0.7, margin: '0 0 12px' }}>{thumb.prompt}</p>
                    <button
                      onClick={() => handleDownload(thumb)}
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
                      Download
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <footer style={{ textAlign: 'center', marginTop: 64, fontSize: 13, opacity: 0.5 }}>
          © 2026 Quickthumb ·{' '}
          <a href="/terms.html" style={{ color: 'inherit' }}>Terms</a> ·{' '}
          <a href="/privacy.html" style={{ color: 'inherit' }}>Privacy</a>
        </footer>
      </div>

      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        input::placeholder { color: rgba(255,255,255,0.4); }
        button:not(:disabled):hover { transform: translateY(-1px); }
      `}</style>
    </main>
  );
}
