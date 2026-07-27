import Stripe from 'stripe';

// Configured ONLY when the secret is present, so the whole billing surface is
// INERT until the env vars are set: no key -> stripe is null -> the checkout/
// portal routes return 503 and the webhook no-ops. Let the SDK default to the
// account's API version (Basil), which is what exposes current_period_end on the
// subscription ITEM (not the Subscription) — see the webhook handler.
export const stripe: Stripe | null = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// price_... id of the monthly Pro plan (created in the Stripe Dashboard).
export const STRIPE_PRICE_ID = process.env.NEXT_PUBLIC_STRIPE_PRICE_ID || '';

// IMAGES granted to a Pro subscriber per billing period. The quota unit is one
// generated image, not one generation — a user picking 1 of the 10 styles is
// charged 1, picking all 10 is charged 10. PHASE2.md recommended 20 generations
// on standard NBP pricing (~40% gross margin), which is 80 images.
//
// The env var is deliberately a NEW name. Reusing STRIPE_PRO_GENERATIONS_LIMIT
// would read a stale `20` already sitting in Vercel and silently grant Pro
// subscribers 20 images instead of 80 — a 4x under-delivery on a paid plan.
export const PRO_IMAGE_CREDITS = Number(process.env.STRIPE_PRO_IMAGE_CREDITS) || 80;

// Credits restored on downgrade — MUST match the app's free-tier default, which
// was DECIDED 2026-06-06 as 1 generation x 4 images = 4 images. Keep this in
// sync with the `profiles.image_credits_limit` column default; if they
// disagree, a Stripe free-downgrade event would silently reset users to the
// wrong number. Override via env if the free tier ever changes.
export const FREE_IMAGE_CREDITS = Number(process.env.FREE_IMAGE_CREDITS) || 4;

// Gate for STARTING a checkout. Requires the secret key, a price id, AND the
// webhook signing secret — because fulfillment (plan upgrade, quota grant)
// happens ONLY in the webhook. If we let a user pay while STRIPE_WEBHOOK_SECRET
// is missing/unset, the webhook no-ops and they'd be charged but never upgraded
// (money taken, nothing delivered). Coupling them here makes that state
// impossible: no webhook secret -> checkout 503s instead of charging. (A wrong
// secret still fails signature verification in the webhook; only the runbook's
// post-switch smoke test catches that — see PHASE2.md §2.)
export function billingConfigured(): boolean {
  return !!stripe && !!STRIPE_PRICE_ID && !!process.env.STRIPE_WEBHOOK_SECRET;
}
