// Verify that the NEXT_PUBLIC_* env vars actually got inlined into the deployed
// CLIENT bundle. This is the diagnostic that caught the 2026-06-09 prod-login
// outage (the Supabase publishable key was marked "Sensitive" in Vercel, so
// Vercel withheld it from the browser build → empty apikey → "Invalid API key"
// on login) and it is the check for the Stripe LIVE-switchover landmine #2/#9
// (a "Sensitive" NEXT_PUBLIC_STRIPE_PRICE_ID makes the Upgrade button vanish).
//
// RULE this enforces: no NEXT_PUBLIC_* var may EVER be marked Sensitive in
// Vercel — Sensitive vars are NOT inlined into the client bundle. The Supabase
// publishable/anon key and the Stripe price id are public-by-design (RLS / a
// price id are safe to expose); only the SECRET keys stay server-only.
//
// Run AFTER every redeploy that touches env vars (esp. the Stripe LIVE switch):
//   npm run verify:prod-env            (checks https://quickthumb.app)
//   npm run verify:prod-env -- https://quickthumb-app.vercel.app
// Needs no secrets — it only fetches the public homepage + its public JS chunks.

const DEFAULT_URL = 'https://quickthumb.app';
const target = (process.argv[2] || process.env.VERIFY_URL || DEFAULT_URL).replace(/\/+$/, '');

// Each check looks for a MARKER in the concatenated client JS + SSR HTML.
//
// For a var used as a VALUE in client code (passed to a function), the inlined
// LITERAL appears in the bundle, so we grep for the value's shape.
//
// For a var used ONLY as a boolean (`!!process.env.NEXT_PUBLIC_X`), the minifier
// constant-folds `!!"the-value"` → `!0` and DROPS the literal entirely — so the
// raw value is NOT in the bundle even when the var is correctly set. (This bit us
// during development: NEXT_PUBLIC_STRIPE_PRICE_ID is only read as
// `billingOn = !!process.env.NEXT_PUBLIC_STRIPE_PRICE_ID` in page.tsx, so the
// price id is folded away.) For those, grep for an EFFECT that survives
// tree-shaking only when the flag is on — here, the `/tokushoho.html` footer
// link, which page.tsx renders inside `billingOn && (...)`. Do NOT "fix" this
// back to grepping `price_`: that produces a false negative.
type Check = {
  name: string;
  envVar: string;
  // a literal substring or a RegExp the bundle should contain when the var is set
  marker: string | RegExp;
  // REQUIRED markers failing -> exit 1 (the app is broken for users).
  // EXPECTED markers failing -> warn only (may be intentionally off, e.g. billing).
  severity: 'required' | 'expected';
  brokenIfMissing: string;
};

const CHECKS: Check[] = [
  {
    name: 'Supabase URL',
    envVar: 'NEXT_PUBLIC_SUPABASE_URL',
    marker: /https:\/\/[a-z0-9-]+\.supabase\.co/,
    severity: 'required',
    brokenIfMissing: 'browser Supabase client has no URL → auth + all client reads fail',
  },
  {
    name: 'Supabase publishable key',
    envVar: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    marker: /sb_publishable_[A-Za-z0-9_-]{8,}/,
    severity: 'required',
    brokenIfMissing: '"Invalid API key" on login (the exact 2026-06-09 outage)',
  },
  {
    // NOTE: marker is the billingOn EFFECT, not the price id — see the type
    // comment above (the price id is folded away by the `!!` minify).
    name: 'Stripe billing UI',
    envVar: 'NEXT_PUBLIC_STRIPE_PRICE_ID',
    marker: '/tokushoho.html',
    severity: 'expected',
    brokenIfMissing: 'Upgrade button never renders → no one can subscribe (billing landmine #2/#9)',
  },
];

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'quickthumb-verify-prod-env' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function extractChunkUrls(html: string, origin: string): string[] {
  // Next.js references client chunks as root-relative /_next/static/.../*.js in
  // <script src> and <link href> (preload). Grab every distinct one.
  const urls = new Set<string>();
  const re = /["'(](\/_next\/static\/[^"')]+?\.js)["')]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) urls.add(origin + m[1]);
  return [...urls];
}

async function main() {
  console.log(`Verifying client-bundle env inlining at ${target}\n`);

  let html: string;
  try {
    html = await fetchText(target + '/');
  } catch (e) {
    console.error(`❌ could not fetch ${target}/ — ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }

  const chunkUrls = extractChunkUrls(html, target);
  if (chunkUrls.length === 0) {
    console.error('❌ no /_next/static/*.js chunks found in the homepage HTML — wrong URL, or not a Next.js build?');
    process.exit(2);
  }

  const chunks = await Promise.all(
    chunkUrls.map(async (u) => {
      try {
        return await fetchText(u);
      } catch {
        return ''; // tolerate an individual chunk 404 (hashed names can race a deploy)
      }
    })
  );
  // Search the homepage HTML too — Next inlines some flight data there.
  const haystack = html + '\n' + chunks.join('\n');
  console.log(`Scanned ${chunkUrls.length} JS chunk(s), ${(haystack.length / 1024 / 1024).toFixed(1)} MB total.\n`);

  let hardFail = 0;
  let warn = 0;
  for (const c of CHECKS) {
    const present =
      typeof c.marker === 'string' ? haystack.includes(c.marker) : c.marker.test(haystack);
    if (present) {
      console.log(`✓ ${c.name} (${c.envVar}) — inlined`);
    } else if (c.severity === 'required') {
      hardFail++;
      console.log(`❌ ${c.name} (${c.envVar}) — MISSING from the client bundle`);
      console.log(`     impact: ${c.brokenIfMissing}`);
      console.log(`     fix: in Vercel, edit ${c.envVar} → toggle "Sensitive" OFF, re-paste the value, then REDEPLOY.`);
    } else {
      warn++;
      console.log(`⚠️  ${c.name} (${c.envVar}) — not found (OK if billing/this feature is intentionally off)`);
      console.log(`     if it SHOULD be on: ${c.brokenIfMissing}`);
      console.log(`     fix: set ${c.envVar} (NOT Sensitive), then REDEPLOY.`);
    }
  }

  console.log('');
  if (hardFail > 0) {
    console.log(`❌ ${hardFail} required env var(s) missing from the client bundle — users are broken. See fixes above.`);
    process.exit(1);
  }
  console.log(warn > 0 ? `✓ all required vars inlined (${warn} optional warning above)` : '✓ all checks passed');
  process.exit(0);
}

main();
