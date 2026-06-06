import createNextIntlPlugin from 'next-intl/plugin';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework.
  poweredByHeader: false,
  // Baseline security headers on every response. These are all zero-breakage for
  // this app (it never frames content or uses camera/mic/geolocation, and every
  // route already declares a correct Content-Type). A real Content-Security-Policy
  // is intentionally NOT set here — a blind CSP would break the Next inline
  // bootstrap + Vercel Analytics, and a nonce-based CSP is a larger follow-up.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: 'replicate.delivery' },
    ],
  },
  // A stray C:\Users\PC_User\package-lock.json makes Next infer the home dir as
  // the workspace root, which both prints a warning AND mis-resolves the
  // outputFileTracingIncludes globs below (and broke .env.local loading in
  // local dev). Pin the root to this project dir. (On Vercel there's no parent
  // lockfile, so this is a no-op there.)
  outputFileTracingRoot: import.meta.dirname,
  serverExternalPackages: ['sharp', '@resvg/resvg-js'],
  outputFileTracingIncludes: {
    '/api/generate': [
      './node_modules/@fontsource/noto-sans-jp/files/*.woff2',
      './node_modules/@fontsource/noto-serif-jp/files/*.woff2',
    ],
  },
};

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

export default withNextIntl(nextConfig);
