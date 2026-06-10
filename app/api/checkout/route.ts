import { NextResponse, type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { stripe, STRIPE_PRICE_ID, billingConfigured } from '@/lib/stripe';

export const runtime = 'nodejs';

// Create a subscription-mode Checkout Session for the logged-in user. Reuses one
// Stripe customer per user so repeat checkouts / the portal stay consistent.
export async function POST(request: NextRequest) {
  try {
    if (!billingConfigured() || !stripe) {
      return NextResponse.json({ error: 'Billing is not configured yet.' }, { status: 503 });
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createServiceClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id, stripe_subscription_id, subscription_status')
      .eq('id', user.id)
      .single();

    // Guard against double-billing. The UI shows "Manage plan" (not "Upgrade")
    // once a user is Pro, but /api/checkout is directly callable, so an
    // already-subscribed user (or a buggy/duplicate client request) could open a
    // SECOND Checkout and end up with two parallel subscriptions on the same
    // customer — two real charges. If a live subscription already exists, refuse
    // and steer them to the billing portal instead.
    const LIVE_SUB_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];
    const status = profile?.subscription_status;
    if (
      profile?.stripe_subscription_id &&
      typeof status === 'string' &&
      LIVE_SUB_STATUSES.includes(status)
    ) {
      return NextResponse.json(
        { error: 'You already have an active subscription.', code: 'already_subscribed' },
        { status: 409 }
      );
    }

    let customerId = (profile?.stripe_customer_id as string | null) || undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await admin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
    }

    const origin = request.headers.get('origin') || new URL(request.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/?upgraded=1`,
      cancel_url: `${origin}/`,
      client_reference_id: user.id,
      subscription_data: { metadata: { supabase_user_id: user.id } },
      allow_promotion_codes: true,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    // Log the raw Stripe/internal error server-side only; never return it to the
    // client (it can carry account/config detail).
    console.error('checkout error', err);
    return NextResponse.json(
      { error: 'Could not start checkout. Please try again.' },
      { status: 500 }
    );
  }
}
