import type { MetadataRoute } from "next";

// Served at /sitemap.xml. Public, indexable routes only — the landing page, the
// signup/login page, and the static legal pages in /public. API routes and the
// auth callback are intentionally excluded (see robots.ts).
const SITE = "https://quickthumb.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE}/auth`, lastModified, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE}/terms.html`, lastModified, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE}/privacy.html`, lastModified, changeFrequency: "yearly", priority: 0.3 },
  ];
}
