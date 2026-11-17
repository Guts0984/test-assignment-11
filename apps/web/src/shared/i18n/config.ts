export const LOCALES = ['en', 'uk'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const isLocale = (v: unknown): v is Locale =>
  typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
