import { NextResponse, type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { stripe } from '@/lib/stripe';

export const runtime = 'nodejs';

// Open the Stripe-hosted Customer Portal so a Pro user can update payment /
// cancel. Cancellation flows back to us via the subscription.updated/deleted
// webhooks. Configure the portal once per mode in the Stripe Dashboard.
export async function POST(request: NextRequest) {
  try {
    if (!stripe) {
      return NextResponse.json(
        { error: 'Billing is not configured yet.', code: 'billing_unconfigured' },
        { status: 503 }
      );
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user)
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });

    const admin = createServiceClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();
    const customerId = profile?.stripe_customer_id as string | null;
    if (!customerId) {
      return NextResponse.json(
        { error: 'No subscription found.', code: 'no_subscription' },
        { status: 400 }
      );
    }

    const origin = request.headers.get('origin') || new URL(request.url).origin;
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/`,
    });
    return NextResponse.json({ url: portal.url });
  } catch (err) {
    // Log server-side only; never surface raw Stripe/internal detail to the client.
    console.error('portal error', err);
    return NextResponse.json(
      { error: 'Could not open the billing portal. Please try again.', code: 'portal_failed' },
      { status: 500 }
    );
  }
}
