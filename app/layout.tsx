import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";

// Locale-specific SEO/social copy. The site serves both EN and JA on one URL
// (cookie/Accept-Language locale — see i18n/request.ts), so a JA visitor used to
// get an English <title> + OG card. generateMetadata() below reads the resolved
// locale and returns the right copy, so a JA user sees JA in their tab and when
// they share the link. (NOTE: this fixes the *user-facing* metadata; making the
// JA page itself search-discoverable still needs per-locale URLs/routing.)
const META = {
  en: {
    title: "Quickthumb — AI thumbnails from a YouTube URL",
    description:
      "Upload your face, paste your video URL, and get 4 finished, click-ready YouTube thumbnails — your face plus a bold hook baked into one image — in seconds. Free to start.",
    ogTitle: "Quickthumb — Paste a URL. Win the click.",
    ogDescription:
      "Upload your face + a YouTube URL. Get 4 finished thumbnails — your face plus a bold hook — in seconds.",
    ogLocale: "en_US",
    altLocale: "ja_JP",
  },
  ja: {
    title: "Quickthumb — YouTubeサムネをURLから60秒で生成",
    description:
      "顔写真をアップして動画URLを貼るだけ。あなたの顔＋強いフックを1枚に焼き込んだ完成サムネを数秒で4枚。まずは無料・クレカ不要。",
    ogTitle: "Quickthumb — URLを貼るだけ。クリックを勝ち取る。",
    ogDescription:
      "顔写真＋YouTubeのURLで、あなたの顔＋強いフックを焼き込んだ完成サムネを数秒で4枚。",
    ogLocale: "ja_JP",
    altLocale: "en_US",
  },
} as const;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = locale === "ja" ? META.ja : META.en;
  return {
    title: m.title,
    description: m.description,
    // Custom domain quickthumb.app went LIVE 2026-06-06 (apex serves production,
    // www 307-redirects to apex; the domain's nameservers are on Vercel DNS). So
    // OG/canonical point at the real brand domain again.
    metadataBase: new URL("https://quickthumb.app"),
    // Self-canonicalize to the apex so the still-reachable quickthumb-app.vercel.app
    // backup origin de-dupes to the brand domain instead of being indexed as a twin.
    alternates: { canonical: "/" },
    icons: {
      icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
      // iOS does not render SVG touch icons — use an opaque 180x180 PNG.
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      title: m.ogTitle,
      description: m.ogDescription,
      url: "https://quickthumb.app",
      siteName: "Quickthumb",
      images: ["/og-image.png"],
      locale: m.ogLocale,
      alternateLocale: [m.altLocale],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: m.ogTitle,
      description: m.ogDescription,
      images: ["/og-image.png"],
    },
  };
}

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
