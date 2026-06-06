import type { MetadataRoute } from "next";

// Served at /robots.txt. Index the public marketing/auth/legal pages; keep the
// API + the OAuth-style auth callback out of the index. Canonical host is the
// brand apex (quickthumb.app went live 2026-06-06).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/callback"],
    },
    sitemap: "https://quickthumb.app/sitemap.xml",
    host: "https://quickthumb.app",
  };
}
