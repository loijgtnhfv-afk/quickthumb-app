import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quickthumb — AI thumbnails from a YouTube URL",
  description: "Upload your face, paste your video URL, and get 4 finished, click-ready YouTube thumbnails — your face plus a bold hook baked into one image — in seconds. Free to start.",
  // Custom domain quickthumb.app went LIVE 2026-06-06 (apex serves production,
  // www 307-redirects to apex; the domain's nameservers are on Vercel DNS). So
  // OG/canonical point at the real brand domain again.
  metadataBase: new URL("https://quickthumb.app"),
  // Self-canonicalize to the apex so the still-reachable quickthumb-app.vercel.app
  // backup origin de-dupes to the brand domain instead of being indexed as a twin.
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    // iOS does not render SVG touch icons — use an opaque 180x180 PNG.
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Quickthumb — Paste a URL. Win the click.",
    description: "Upload your face + a YouTube URL. Get 4 finished thumbnails — your face plus a bold hook — in seconds.",
    url: "https://quickthumb.app",
    siteName: "Quickthumb",
    images: ["/og-image.png"],
    locale: "en_US",
    alternateLocale: ["ja_JP"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Quickthumb — Paste a URL. Win the click.",
    description: "Upload your face + a YouTube URL. Get 4 finished thumbnails — your face plus a bold hook — in seconds.",
    images: ["/og-image.png"],
  },
};

// Static Organization + WebSite + SoftwareApplication JSON-LD for richer SERP
// eligibility. Values mirror the metadata above; no user input is interpolated.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://quickthumb.app/#org",
      name: "Quickthumb",
      url: "https://quickthumb.app",
      logo: "https://quickthumb.app/og-image.png",
    },
    {
      "@type": "WebSite",
      "@id": "https://quickthumb.app/#website",
      url: "https://quickthumb.app",
      name: "Quickthumb",
      publisher: { "@id": "https://quickthumb.app/#org" },
      inLanguage: ["en", "ja"],
    },
    {
      "@type": "SoftwareApplication",
      name: "Quickthumb",
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Web",
      url: "https://quickthumb.app",
      description:
        "Upload your face, paste your video URL, and get finished, click-ready YouTube thumbnails — your face plus a bold hook baked into one image — in seconds.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
        <Analytics />
      </body>
    </html>
  );
}
