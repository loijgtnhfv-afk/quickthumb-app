import { type NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { stripe, PRO_IMAGE_CREDITS, FREE_IMAGE_CREDITS } from '@/lib/stripe';

export const runtime = 'nodejs';

// Basil moved current_period_end onto the subscription ITEM; read it there with a
// fallback to the legacy top-level field for older API versions.
function periodEndUnixOf(sub: Stripe.Subscription): number | undefined {
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  return item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
}
function periodEndIsoOf(sub: Stripe.Subscription): string | null {
  const unix = periodEndUnixOf(sub);
  return unix ? new Date(unix * 1000).toISOString() : null;
}

// Stripe billing webhook. Verifies the raw body against the signing secret, then
// flips profiles.plan / image_credits_limit on the three lifecycle events. Writes
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
          // Anchor current_period_end at fulfillment so the renewal-reset
          // comparison has a real baseline from day one. Without it the column
          // stays NULL until the first subscription.updated, and a benign
          // mid-cycle update would read prevEnd=0, treat it as a renewal, and
          // wrongly refill the quota.
          let periodEndIso: string | null = null;
          if (subscriptionId) {
            try {
              const sub = await stripe.subscriptions.retrieve(subscriptionId);
              periodEndIso = periodEndIsoOf(sub);
            } catch (e) {
              console.warn('subscription retrieve for period end failed:', e instanceof Error ? e.message : e);
            }
          }
          const { error: fulfilErr } = await admin
            .from('profiles')
            .update({
              plan: 'pro',
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              subscription_status: 'active',
              image_credits_limit: PRO_IMAGE_CREDITS,
              image_credits_used: 0,
              ...(periodEndIso ? { current_period_end: periodEndIso } : {}),
            })
            .eq('id', userId);
          // This is fulfillment: the money has already been taken. Swallowing a
          // failed write here returns 200, Stripe records the event as
          // delivered and never retries, and the customer is charged for a Pro
          // plan they never receive. A 500 makes Stripe retry instead, which is
          // safe because every write in this handler SETS target state rather
          // than incrementing.
          if (fulfilErr) {
            console.error('stripe webhook: fulfillment update failed', fulfilErr);
            return new Response('fulfillment update failed', { status: 500 });
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = customerIdOf(sub.customer);
        if (!customerId) break;
        const status = sub.status;
        // Keep serving Pro through Stripe's dunning grace (past_due/unpaid) — a
        // transient card decline shouldn't instantly strip a paying user to the
        // free limit while Stripe is still retrying. Only a real cancel
        // (subscription.deleted) or a terminal status falls to free.
        const inGrace =
          status === 'active' || status === 'trialing' || status === 'past_due' || status === 'unpaid';
        const trulyActive = status === 'active' || status === 'trialing';
        const periodEndUnix = periodEndUnixOf(sub);
        const periodEndIso = periodEndIsoOf(sub);

        // Detect a renewal (period advanced past what we stored) -> reset usage.
        const { data: prof } = await admin
          .from('profiles')
          .select('current_period_end')
          .eq('stripe_customer_id', customerId)
          .single();
        const prevEndMs = prof?.current_period_end ? Date.parse(prof.current_period_end) : 0;
        const renewed = periodEndUnix ? periodEndUnix * 1000 > prevEndMs : false;

        const update: Record<string, unknown> = {
          subscription_status: status,
          stripe_subscription_id: sub.id,
          plan: inGrace ? 'pro' : 'free',
          image_credits_limit: inGrace ? PRO_IMAGE_CREDITS : FREE_IMAGE_CREDITS,
        };
        // Advance the stored period end only on a confirmed-active event and
        // never backward (reordered deliveries), so the renewal comparison stays
        // sound and a dunning event doesn't move the baseline.
        if (trulyActive && periodEndUnix && periodEndUnix * 1000 >= prevEndMs) {
          update.current_period_end = periodEndIso;
        }
        if (renewed && trulyActive) update.image_credits_used = 0;
        const { error: updErr } = await admin
          .from('profiles')
          .update(update)
          .eq('stripe_customer_id', customerId);
        if (updErr) {
          console.error('stripe webhook: subscription.updated write failed', updErr);
          return new Response('subscription update failed', { status: 500 });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = customerIdOf(sub.customer);
        if (!customerId) break;
        const { error: delErr } = await admin
          .from('profiles')
          .update({
            plan: 'free',
            subscription_status: 'canceled',
            stripe_subscription_id: null,
            image_credits_limit: FREE_IMAGE_CREDITS,
          })
          .eq('stripe_customer_id', customerId);
        // Failing loudly matters in the other direction here: a silently
        // dropped cancellation leaves a former subscriber on the Pro limit
        // indefinitely.
        if (delErr) {
          console.error('stripe webhook: subscription.deleted write failed', delErr);
          return new Response('cancellation update failed', { status: 500 });
        }
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
