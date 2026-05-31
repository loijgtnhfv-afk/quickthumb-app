import createNextIntlPlugin from 'next-intl/plugin';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
