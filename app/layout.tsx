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
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/favicon.svg",
  },
  openGraph: {
    title: "Quickthumb — Paste a URL. Win the click.",
    description: "Upload your face + a YouTube URL. Get 4 finished thumbnails — your face plus a bold hook — in seconds.",
    url: "https://quickthumb.app",
    siteName: "Quickthumb",
    images: ["/og-image.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Quickthumb — Paste a URL. Win the click.",
    description: "Upload your face + a YouTube URL. Get 4 finished thumbnails — your face plus a bold hook — in seconds.",
    images: ["/og-image.png"],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
        <Analytics />
      </body>
    </html>
  );
}
