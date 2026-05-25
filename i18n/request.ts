import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

export const SUPPORTED_LOCALES = ['en', 'ja'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'NEXT_LOCALE';

function isSupportedLocale(value: string | undefined | null): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// Picks the locale for this request: explicit cookie > Accept-Language hint > default.
async function resolveLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isSupportedLocale(cookieLocale)) return cookieLocale;

  const acceptLang = (await headers()).get('accept-language') || '';
  // Accept-Language is a comma-separated, q-weighted list; the first hit on ja
  // is enough — we only ship two locales.
  if (/\bja\b/i.test(acceptLang)) return 'ja';
  return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  const messages = (await import(`../messages/${locale}.json`)).default;
  return { locale, messages };
});
