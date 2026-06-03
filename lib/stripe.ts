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

// Generations granted to a Pro subscriber per billing period. PHASE2.md
// recommends 20 on standard NBP pricing (~40% gross margin); override via env.
export const PRO_GENERATIONS_LIMIT = Number(process.env.STRIPE_PRO_GENERATIONS_LIMIT) || 20;

// Limit restored on downgrade (matches the app's free-tier default).
export const FREE_GENERATIONS_LIMIT = Number(process.env.FREE_GENERATIONS_LIMIT) || 2;

// True only when both the secret key and a price id are present.
export function billingConfigured(): boolean {
  return !!stripe && !!STRIPE_PRICE_ID;
}
