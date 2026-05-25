import { NextResponse, type NextRequest } from 'next/server';
import { SUPPORTED_LOCALES, LOCALE_COOKIE } from '@/i18n/request';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const candidate = typeof body.locale === 'string' ? body.locale : '';
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(candidate)) {
    return NextResponse.json({ error: 'Unsupported locale' }, { status: 400 });
  }
  const res = NextResponse.json({ locale: candidate });
  res.cookies.set(LOCALE_COOKIE, candidate, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  return res;
}
