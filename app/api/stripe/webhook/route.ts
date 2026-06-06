import { type NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { stripe, PRO_GENERATIONS_LIMIT, FREE_GENERATIONS_LIMIT } from '@/lib/stripe';

export const runtime = 'nodejs';

// Stripe billing webhook. Verifies the raw body against the signing secret, then
// flips profiles.plan / generations_limit on the three lifecycle events. Writes
// go through the service-role client (RLS protects billing fields from the anon
// key) and are idempotent (SET target state, never increment) since Stripe
// retries and can reorder/duplicate deliveries. INERT until the env vars are set.
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    // Billing not configured — 200 so Stripe (if somehow pointed here) doesn't retry-storm.
    return new Response('billing not configured', { status: 200 });
  }
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });

  // Must be the EXACT raw body — never JSON.parse first or the signature breaks.
  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, secret);
  } catch (err) {
    // Log the verification detail server-side; return only a generic message so
    // we don't reflect attacker-controlled / internal detail in the 400 body.
    console.warn('stripe webhook signature failed:', err instanceof Error ? err.message : err);
    return new Response('invalid signature', { status: 400 });
  }

  const admin = createServiceClient();
  const customerIdOf = (c: string | { id: string } | null | undefined): string | undefined =>
    typeof c === 'string' ? c : c?.id;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = (s.client_reference_id || s.metadata?.supabase_user_id) ?? undefined;
        const customerId = customerIdOf(s.customer);
        const subscriptionId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
        if (userId) {
          await admin
            .from('profiles')
            .update({
              plan: 'pro',
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              subscription_status: 'active',
              generations_limit: PRO_GENERATIONS_LIMIT,
              generations_used: 0,
            })
            .eq('id', userId);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = customerIdOf(sub.customer);
        if (!customerId) break;
        const active = sub.status === 'active' || sub.status === 'trialing';
        // Basil moved current_period_end onto the subscription ITEM; fall back to
        // the legacy top-level field for older API versions.
        const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
        const periodEndUnix =
          item?.current_period_end ??
          (sub as unknown as { current_period_end?: number }).current_period_end;
        const periodEndIso = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;

        // Detect a renewal (period advanced past what we stored) -> reset usage.
        const { data: prof } = await admin
          .from('profiles')
          .select('current_period_end')
          .eq('stripe_customer_id', customerId)
          .single();
        const prevEndMs = prof?.current_period_end ? Date.parse(prof.current_period_end) : 0;
        const renewed = periodEndUnix ? periodEndUnix * 1000 > prevEndMs : false;

        const update: Record<string, unknown> = {
          subscription_status: sub.status,
          stripe_subscription_id: sub.id,
          plan: active ? 'pro' : 'free',
          generations_limit: active ? PRO_GENERATIONS_LIMIT : FREE_GENERATIONS_LIMIT,
          current_period_end: periodEndIso,
        };
        if (renewed && active) update.generations_used = 0;
        await admin.from('profiles').update(update).eq('stripe_customer_id', customerId);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = customerIdOf(sub.customer);
        if (!customerId) break;
        await admin
          .from('profiles')
          .update({
            plan: 'free',
            subscription_status: 'canceled',
            stripe_subscription_id: null,
            generations_limit: FREE_GENERATIONS_LIMIT,
          })
          .eq('stripe_customer_id', customerId);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('stripe webhook handler error:', err);
    return new Response('handler error', { status: 500 });
  }
  return new Response(null, { status: 200 });
}
