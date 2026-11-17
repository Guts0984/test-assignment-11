export type AppLocale = 'en' | 'uk';

/** Integer kopecks → "1 234,50 ₴" (uk) / "₴1,234.50" (en). Never floats on the way in: amounts are whole kopecks. */
export function formatMoney(kop: number, locale: AppLocale): string {
  const fmt = new Intl.NumberFormat(locale === 'uk' ? 'uk-UA' : 'en-US', {
    style: 'currency',
    currency: 'UAH',
    currencyDisplay: 'narrowSymbol',
  });
  const sign = kop < 0 ? '-' : '';
  const abs = Math.abs(kop);
  const hryvnias = Math.trunc(abs / 100);
  const k = abs % 100;
  return sign + fmt.format(hryvnias + k / 100);
}

/**
 * User input in hryvnias → integer kopecks. Accepts "1234", "1234,5", "1 234.50"; rejects more than 2 decimals,
 * negatives, letters and empty text (returns null).
 */
export function parseMoneyToKop(input: string): number | null {
  const t = input.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [h, f = ''] = t.split('.');
  const kop = Number(h) * 100 + Number(f.padEnd(2, '0'));
  return Number.isSafeInteger(kop) ? kop : null;
}

/** 123450 → "1234.50" for pre-filling inputs. */
export function kopToInput(kop: number): string {
  return `${Math.trunc(kop / 100)}.${String(kop % 100).padStart(2, '0')}`;
}

export function formatDateTime(iso: string, locale: AppLocale, timeZone = 'Europe/Kyiv'): string {
  return new Intl.DateTimeFormat(locale === 'uk' ? 'uk-UA' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso));
}

export function formatDuration(seconds: number | null, locale: AppLocale): string {
  if (seconds === null) return '–';
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  const unit = locale === 'uk' ? { h: 'год', m: 'хв' } : { h: 'h', m: 'min' };
  return h > 0 ? `${h} ${unit.h} ${m % 60} ${unit.m}` : `${m} ${unit.m}`;
}

export function formatWeight(g: number, locale: AppLocale): string {
  const kg = new Intl.NumberFormat(locale === 'uk' ? 'uk-UA' : 'en-US', {
    maximumFractionDigits: 3,
  }).format(g / 1000);
  return `${kg} ${locale === 'uk' ? 'кг' : 'kg'}`;
}
