'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { LOCALES, LOCALE_COOKIE, type Locale } from '@/shared/i18n';

export function LocaleSwitcher() {
  const locale = useLocale() as Locale;
  const t = useTranslations('locale');
  const router = useRouter();
  const set = (l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  return (
    <div role="group" aria-label={t('label')} className="flex gap-1">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => set(l)}
          aria-pressed={l === locale}
          lang={l}
          className={`min-h-9 rounded px-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${l === locale ? 'bg-slate-900 text-white' : 'bg-white text-slate-900 ring-1 ring-slate-300'}`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
