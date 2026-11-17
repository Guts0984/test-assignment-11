import { BUSINESS_TIMEZONE } from './constants';

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

type LocalParts = { y: number; m: number; d: number; h: number; mi: number; s: number };

export function localParts(instant: Date, tz: string = BUSINESS_TIMEZONE): LocalParts {
  const get: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(instant)) {
    if (p.type !== 'literal') get[p.type] = Number(p.value);
  }
  return {
    y: get.year!,
    m: get.month!,
    d: get.day!,
    h: get.hour!,
    mi: get.minute!,
    s: get.second!,
  };
}

/** Offset (local - UTC) in ms of `tz` at the given instant. */
export function tzOffsetMs(instant: Date, tz: string = BUSINESS_TIMEZONE): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the local wall clock in `tz` reads y-m-d 00:00:00. */
export function startOfLocalDay(
  y: number,
  m: number,
  d: number,
  tz: string = BUSINESS_TIMEZONE,
): Date {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = naive - tzOffsetMs(new Date(naive), tz);
  // The offset may differ at the corrected instant around DST changes; re-evaluate once.
  const corrected = naive - tzOffsetMs(new Date(guess), tz);
  if (corrected !== guess) guess = corrected;
  return new Date(guess);
}

/** Start of the next business day (local midnight) after `failedAt`. Used for `next_attempt_at`. */
export function nextAttemptAt(failedAt: Date, tz: string = BUSINESS_TIMEZONE): Date {
  const p = localParts(failedAt, tz);
  const nextDay = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return startOfLocalDay(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    tz,
  );
}

/** Calendar date (YYYY-MM-DD) of `instant` in `tz`. */
export function localDate(instant: Date, tz: string = BUSINESS_TIMEZONE): string {
  const p = localParts(instant, tz);
  return `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
