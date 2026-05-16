import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quickthumb — AI thumbnails from a YouTube URL",
  description: "Paste a YouTube URL. Our AI watches your video, finds the click-worthy moment, and generates thumbnails proven to boost views.",
  metadataBase: new URL("https://quickthumb.app"),
  openGraph: {
    title: "Quickthumb — Paste a URL. Win the click.",
    description: "AI watches your YouTube video and generates 4 click-tested thumbnails in 60 seconds.",
    url: "https://quickthumb.app",
    siteName: "Quickthumb",
    images: ["/og-image.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Quickthumb — Paste a URL. Win the click.",
    description: "AI watches your YouTube video and generates 4 click-tested thumbnails in 60 seconds.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
