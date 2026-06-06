import type { createServiceClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createServiceClient>;

/**
 * Lightweight per-user rate limit with NO extra infrastructure: count this
 * user's recent rows in a trailing time window and compare to a cap. It uses a
 * service-role client so it sees all of the user's rows regardless of RLS.
 *
 * FAIL-OPEN by design: any query error (e.g. the table has no `created_at`
 * column, or a transient DB issue) returns `false` (not limited) and logs a
 * warning, so the limiter can NEVER break the live path — a misconfigured
 * limiter is observable, not fatal. It's an abuse brake, not a hard guarantee;
 * a couple of concurrent requests can both pass the window check (acceptable for
 * an hourly cap). Move to a token bucket (Upstash/WAF) if a strict limit is
 * needed.
 */
export async function isRateLimited(
  admin: Admin,
  opts: {
    table: 'generations' | 'usage_logs';
    userId: string;
    windowMs: number;
    max: number;
    /** Only count rows with this event_type (for usage_logs). */
    eventType?: string;
  }
): Promise<boolean> {
  try {
    const sinceIso = new Date(Date.now() - opts.windowMs).toISOString();
    let q = admin
      .from(opts.table)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', opts.userId)
      .gte('created_at', sinceIso);
    if (opts.eventType) q = q.eq('event_type', opts.eventType);
    const { count, error } = await q;
    if (error) {
      console.warn(`rate-limit query failed on ${opts.table} (allowing request):`, error.message);
      return false;
    }
    return (count ?? 0) >= opts.max;
  } catch (e) {
    console.warn('rate-limit check threw (allowing request):', e);
    return false;
  }
}
