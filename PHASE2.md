# Quickthumb — Phase 2 plan

Drafted 2026-06-03 from a web-grounded research pass (Stripe / Supabase / Google / Anthropic primary docs). Phase-1 (Nano Banana Pro engine + persona face upload) is live; this is what's next.

## 0. Pricing — FREE TIER DECIDED 2026-06-06 (Pro/Pro Max prices below, confirm at Stripe activation)

> **DECIDED 2026-06-06:** FREE = **1 generation × 4 images** ($0.54/signup). Set `generations_limit` default to 1 (4-image cap is already enforced in code by `NBP_CONCEPTS.length`). PRO = $18 / ¥2,880 / 20 gen, PRO MAX = $39 / ¥6,200 / 45 gen (locked in for Stripe activation, §2). The SQL is in "SQL to apply" below.

Hard cost (verified 2026-06-03): NBP standard = **$0.134/image**, so 4-image generation = **~$0.54/gen**. Google's **Batch API halves it** ($0.067/img → $0.27/gen) but is queue-based, not real-time, and would require moving off Replicate to the native Gemini API (`gemini-3-pro-image`) — a separate engine-integration task (see §0.3).

### Recommended config (founder: confirm or tweak)

Meter by **generations** in the UI; enforce the per-gen image cap internally.

| Plan | Price | Caps | Images | Hard cost | Margin (pre-fees) |
|------|-------|------|--------|-----------|-------------------|
| **FREE** | $0 | **1 gen × 4 img** | 4 / signup | **$0.54/signup** | — (acquisition) |
| **PRO** | **$18 / ¥2,880** /mo | 20 gen × 4 | 80/mo | $10.72 | **40%** |
| **PRO MAX** | **$39 / ¥6,200** /mo | 45 gen × 4 | 180/mo | $24.12 | **38%** |

On Batch later: bump PRO→30 gen (55% margin), PRO MAX→60 gen (59%) at the same prices.

### The one real decision: the FREE tier

The pivot's entire value prop is **"4 conceptually-different finished thumbnails"** (face-surprise / jp-telop / global-clean / action). So the free tier's job is to show that wow and convert — not to be maximally cheap.

| Free option | Images | $/signup | 1k signups | Trade-off |
|-------------|--------|----------|------------|-----------|
| **1 gen × 4 img** *(recommended)* | 4 | **$0.54** | $536 | Full 4-grid wow once; 1 gen is enough friction to push upgrade |
| 2 gen × 2 img | 4 | $0.54 | $536 | Two tries but only 2 concepts each — partial wow |
| 2 gen × 1 img | 2 | $0.27 | $268 | Cheapest, but a single image guts the "4 concepts" demo |

**Recommendation: FREE = 1 generation × 4 images.** Same $/signup as 2×2 but delivers the complete product experience in the one free shot, which should convert better than rationing single images. The old `generations_limit = 2 × 4-img` (~$1.07/signup) is the one to retire.

⚠️ The old "trap" plan ($18 for 30 gen = 120 img standard = only 10.7% margin, a loss after fees) is killed — the table above is the corrected structure.

### Guardrails (all free tiers)
- Gate free behind email-verify / OAuth + per-IP rate-limit (disposable-email abuse).
- Native Stripe Prices in **both USD and JPY** — JPY is zero-decimal, so send `2880` / `6200` (NOT `288000`). Re-check USD/JPY (~159.85 on 2026-06-03; $18≈¥2,877, $39≈¥6,234) before launch.

### §0.3 Biggest margin lever — Batch API
Moving generation to Google's Batch API (~½ cost → ~2× margin) is the single biggest economics win, but: (a) it's latency-tolerant only (queue + notify, not the current ~40s real-time UX), and (b) NBP-via-Replicate has no batch endpoint — you'd integrate the native Gemini API. Defer until there's paid volume; keep real-time on the 40%-margin caps for launch.

Competitor anchors: Samune (JP) ¥990/30, ¥1,980/60, ¥4,980/200 (1 credit = 1 img); Pikzels $28/$56; 1of10 $69.

### SQL to apply once the FREE tier is decided
For **1 gen × 4 img**: `alter table profiles alter column generations_limit set default 1;` (and `update profiles set generations_limit = 1 where plan = 'free';` for existing rows). The 4-image cap is already enforced in code by `NBP_CONCEPTS.length`.

## 1. Persona face-validation — DONE (shipped)

`app/api/upload-persona/route.ts`: one Claude Haiku vision call after a 512px sharp downscale; rejects a confident no-face / multiple-faces (HTTP 422 → localized `persona.faceRejected`), FAIL-OPEN on any error/missing key/low confidence. Cost ~$0.001/upload.

## 2. Stripe Pro subscription — CODE SHIPPED (inert until configured)

The integration is in the repo and INERT until env vars are set: `lib/stripe.ts`, `app/api/checkout/route.ts`, `app/api/stripe/webhook/route.ts`, `app/api/portal/route.ts`, and the Upgrade/Manage buttons in `page.tsx` (shown only when `NEXT_PUBLIC_STRIPE_PRICE_ID` is set). It has NOT been tested against real Stripe — test in Stripe TEST mode before going live.

**To ACTIVATE (founder, in order):**
1. Stripe Dashboard (Test mode) → create Product "QuickThumb Pro" + a recurring monthly Price (set the ¥/$ amount — see §0). Copy the `price_…` id.
2. Supabase SQL: `alter table profiles add column stripe_customer_id text unique, add column stripe_subscription_id text, add column subscription_status text, add column current_period_end timestamptz;`
3. Vercel env (Production + Preview): `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` (from step 5), optional `STRIPE_PRO_GENERATIONS_LIMIT` (default 20).
4. Stripe Dashboard → configure the Customer Portal (test AND live).
5. Stripe Dashboard → Webhooks → add `https://<domain>/api/stripe/webhook`, subscribe to `checkout.session.completed` + `customer.subscription.updated` + `customer.subscription.deleted`; copy ITS signing secret into `STRIPE_WEBHOOK_SECRET`.
6. Test (TEST mode): `stripe listen --forward-to localhost:3000/api/stripe/webhook` + a real checkout with card `4242 4242 4242 4242`; confirm the profile flips to `pro` + limit, and cancel via the portal downgrades it.
7. Repeat Product/Price/Portal/Webhook in LIVE mode; swap to `sk_live_…` + live price id + live webhook secret.

> **STATUS 2026-06-11:** TEST mode is FULLY VERIFIED e2e on prod — upgrade (pay → pro, 20/20) AND immediate-cancel downgrade (→ free, 1/1) both confirmed. Steps 1–6 done in TEST. Remaining = LIVE switch-over (step 7) + filling the legal placeholders (§ below / project memory). Pricing DECIDED (FREE = 1 gen × 4 img, PRO = 20 @ $18/mo). The `generations_limit` column default = 1; SQL done.

### ⚠️ LIVE-SWITCHOVER LANDMINES (from the 2026-06-11 pre-LIVE money-path audit — read before flipping live keys)

These are config mistakes, not code bugs. They are how you accidentally charge real money and deliver nothing, or kill the paid flow:

1. **`STRIPE_WEBHOOK_SECRET` wrong/missing → user is charged but never upgraded** (the webhook is the ONLY fulfillment path; with a bad secret it no-ops). Mitigation now in code: `billingConfigured()` requires the webhook secret to be PRESENT, so a *missing* one makes `/api/checkout` 503 instead of charging. A *wrong* value still passes presence but fails signature → only the post-switch smoke test (step below) catches it. So: after setting LIVE keys, ALWAYS do one real-card checkout and confirm the profile flips to `pro` BEFORE announcing.
2. **`NEXT_PUBLIC_STRIPE_PRICE_ID` marked "Sensitive" in Vercel → the upgrade button never appears / billing looks dead.** Vercel does NOT inline a Sensitive var into the client bundle (this is the exact class of bug that took down prod login on 2026-06-09 with the Supabase publishable key). **Rule: no `NEXT_PUBLIC_*` var may EVER be Sensitive.** The Stripe price id is public-safe. Verify after deploy by grepping the prod JS chunks for `price_`.
3. **Wrong-mode / deleted price id passes `billingConfigured()` then 500s inside Stripe.** The gate only checks the id is non-empty, not that it's a valid LIVE price. Use the LIVE-mode `price_…` (created in LIVE, not TEST) and confirm checkout opens with the right amount in the smoke test.
4. **Env vars only take effect after a REDEPLOY.** `NEXT_PUBLIC_*` is build-time-inlined → set all LIVE vars, then redeploy ONCE.
5. **LIVE Customer Portal must be enabled separately** (Stripe configures test + live portals independently) or `/api/portal` 500s for paying users.

**LIVE smoke test (do every time after switching keys):** real card → expect `plan=pro` + `generations_limit=20` + `generations_used=0` + header shows "Manage plan"; then immediate-cancel in the Stripe dashboard → expect `plan=free` + `generations_limit=1` + header shows "Upgrade"; then REFUND the test charge.

Implementation notes (what the shipped code does):

- `lib/stripe.ts` lets the SDK default to the account's Basil API (no pinned apiVersion). Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (different for CLI vs deployed), `NEXT_PUBLIC_STRIPE_PRICE_ID`.
- `profiles` += `stripe_customer_id` (unique), `stripe_subscription_id`, `subscription_status`, `current_period_end timestamptz`.
- `app/api/checkout/route.ts`: subscription-mode Checkout Session, reuse one Stripe customer per user (`customer`, not `customer_email`), `client_reference_id = user.id`.
- `app/api/stripe/webhook/route.ts` (`runtime = 'nodejs'`): read raw body with `await req.text()` (never JSON.parse first), verify with `stripe.webhooks.constructEventAsync`. Handle:
  - `checkout.session.completed` → plan='pro', set `generations_limit`, reset `generations_used`, store stripe ids.
  - `customer.subscription.updated` → map status; **`current_period_end` is now `subscription.items.data[0].current_period_end`** (Basil moved it off the Subscription — the old top-level field is `undefined`).
  - `customer.subscription.deleted` → plan='free', `generations_limit = FREE_GENERATIONS_LIMIT` (=1).
  - Writes via `createServiceClient`; idempotent (SET target state, don't increment).
- `app/api/portal/route.ts`: `stripe.billingPortal.sessions.create`. Configure the portal in Dashboard (test AND live).
- Monthly reset: on-read in `/api/generate` (reset `generations_used` when `now >= current_period_end`) + optional daily Vercel Cron backstop (Hobby = once/day max).
- Test: `stripe listen --forward-to localhost:3000/api/stripe/webhook` + card `4242 4242 4242 4242`. Don't provision from the `success_url` redirect — only the webhook is a reliable fulfillment signal.

## 3. YouTube OAuth ownership verification (longest lead — start early)

Trust upgrade so a user can prove they own a channel (beyond the persona-upload consent model).

- Google Cloud Web OAuth client + enable YouTube Data API v3; redirect URI = `https://<PROJECT_REF>.supabase.co/auth/v1/callback` (the **Supabase** callback, not the app's). Enable the Google provider in Supabase Auth.
- `signInWithOAuth({ provider:'google', options:{ scopes:'https://www.googleapis.com/auth/youtube.readonly', queryParams:{ access_type:'offline', prompt:'consent' } } })`. In the existing PKCE callback, use `session.provider_token` → `GET youtube/v3/channels?part=id&mine=true` → `items[0].id` = verified own channel. Store `profiles.verified_youtube_channel_id`; **discard the token** (it's ~1h and Supabase doesn't persist/refresh it).
- **`youtube.readonly` is a SENSITIVE scope → Google app verification required** before public use: published privacy policy on the same domain (have `privacy.html` now), real homepage, Search Console domain verification, per-scope justification, unlisted demo video. Quoted 3-5 business days, often **weeks**. Run in "Testing" mode (~100 users, warning screen) meanwhile. No CASA audit (sensitive ≠ restricted) — confirm the tier label in the console.
- Make it opt-in on a settings page; keep email/password as primary auth so a verification delay never blocks signups/generations.

---
Full sourced findings: workflow run `wtw8tb0qb` (transcript in the session subagents dir).
