/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
    images: {
        remotePatterns: [
              { protocol: "https", hostname: "i.ytimg.com" },
                    { protocol: "https", hostname: "*.supabase.co" },
                          { protocol: "https", hostname: "replicate.delivery" },
                              ],
                                },
                                };

                                export default nextConfig;
                                
