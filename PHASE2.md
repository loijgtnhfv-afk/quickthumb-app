# Quickthumb — Phase 2 plan

Drafted 2026-06-03 from a web-grounded research pass (Stripe / Supabase / Google / Anthropic primary docs). Phase-1 (Nano Banana Pro engine + persona face upload) is live; this is what's next.

## 0. Pricing — DECISION NEEDED (most important, blocks Stripe)

Hard cost: NBP standard = **$0.134/image × 4 = ~$0.54/generation**. Google **Batch API halves it** ($0.067/img → $0.27/gen) but adds latency (queue, not real-time).

The trap (verified):
- Current **free tier = 2 gen × 4 img = 8 images ≈ $1.07/signup** → bleeds at scale (1,000 signups ≈ $1,072).
- **$18/mo for 30 generations (120 img) on standard = only 10.7% margin** → a loss after Stripe/Supabase/Vercel fees.

Recommended structure (meter by **generations** in the UI; enforce an image cap internally):
- **FREE: 2 generations × 1 image** (2 free images, not 8) → ~$0.27/signup, ~4× cheaper. ⚠️ trade-off: free users no longer get the full 4-grid "wow". Alternative: 2 gen × 2 img.
- **PRO — $18 / ¥2,880:** 20 gen (80 img) standard = **40% margin**; raise to 30 gen when on Batch (55%).
- **PRO MAX — $39 / ¥6,200:** 45 gen (180 img) standard = 38%; 60 gen on Batch (59%).
- Native Stripe Prices in **both USD and JPY** (JPY is zero-decimal → send `2880`, not `288000`). Re-check USD/JPY (~159.85 on 2026-06-03) before launch.
- Gate free behind email-verify / OAuth + per-IP rate-limit (disposable-email abuse).
- **Biggest lever: move generation to the Batch API** (latency-tolerant: queue + notify) → ~2× margins. If real-time is required, stay on the lower (40%) caps.

Competitor anchors: Samune (JP) ¥990/30, ¥1,980/60, ¥4,980/200 (1 credit = 1 img); Pikzels $28/$56; 1of10 $69.

## 1. Persona face-validation — DONE (shipped)

`app/api/upload-persona/route.ts`: one Claude Haiku vision call after a 512px sharp downscale; rejects a confident no-face / multiple-faces (HTTP 422 → localized `persona.faceRejected`), FAIL-OPEN on any error/missing key/low confidence. Cost ~$0.001/upload.

## 2. Stripe Pro subscription

- `npm i stripe`; `lib/stripe.ts` (let it default to the account's Basil API — do NOT pin an old apiVersion). Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (different for CLI vs deployed), `NEXT_PUBLIC_STRIPE_PRICE_ID`.
- `profiles` += `stripe_customer_id` (unique), `stripe_subscription_id`, `subscription_status`, `current_period_end timestamptz`.
- `app/api/checkout/route.ts`: subscription-mode Checkout Session, reuse one Stripe customer per user (`customer`, not `customer_email`), `client_reference_id = user.id`.
- `app/api/stripe/webhook/route.ts` (`runtime = 'nodejs'`): read raw body with `await req.text()` (never JSON.parse first), verify with `stripe.webhooks.constructEventAsync`. Handle:
  - `checkout.session.completed` → plan='pro', set `generations_limit`, reset `generations_used`, store stripe ids.
  - `customer.subscription.updated` → map status; **`current_period_end` is now `subscription.items.data[0].current_period_end`** (Basil moved it off the Subscription — the old top-level field is `undefined`).
  - `customer.subscription.deleted` → plan='free', limit=2.
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
