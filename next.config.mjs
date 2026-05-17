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
  serverExternalPackages: ['sharp', '@resvg/resvg-js'],
  outputFileTracingIncludes: {
    '/api/generate': [
      './node_modules/@fontsource/noto-sans-jp/files/*.woff2',
      './node_modules/@fontsource/noto-serif-jp/files/*.woff2',
    ],
  },
};

export default nextConfig;
