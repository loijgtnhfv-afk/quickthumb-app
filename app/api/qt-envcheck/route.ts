import { NextResponse, type NextRequest } from 'next/server';

// TEMPORARY diagnostic endpoint — added 2026-05-30 to verify which env vars
// are actually present in the production runtime (vercel env pull returns empty
// for Sensitive vars, so pull output can't be trusted). Returns ONLY booleans
// and value lengths — never the values themselves. REMOVE after verification.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN = 'qt-envcheck-7f3a91';

const KEYS = [
  'ANTHROPIC_API_KEY',
  'YOUTUBE_API_KEY',
  'REPLICATE_API_TOKEN',
  'SUPABASE_SECRET_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const present: Record<string, boolean> = {};
  const length: Record<string, number> = {};
  for (const k of KEYS) {
    const v = process.env[k];
    present[k] = typeof v === 'string' && v.length > 0;
    length[k] = typeof v === 'string' ? v.length : -1;
  }
  return NextResponse.json({ present, length, vercelEnv: process.env.VERCEL_ENV ?? null });
}
