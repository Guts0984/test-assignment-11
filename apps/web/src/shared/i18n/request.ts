import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { publicEnv } from '../config/env';
import { isLocale, LOCALE_COOKIE } from './config';

/** No locale in the URL: the choice lives in a cookie, so /courier and /track/… stay as they are. */
export default getRequestConfig(async () => {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(c)
    ? c
    : isLocale(publicEnv.defaultLocale)
      ? publicEnv.defaultLocale
      : 'en';
  return {
    locale,
    timeZone: 'Europe/Kyiv',
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
