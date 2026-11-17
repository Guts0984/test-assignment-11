import { normalizePhone } from '@courier/shared';

export type SearchIntent = {
  /** exact delivery number, e.g. DLV-000123 or 123 */
  number?: number;
  /** exact normalised phone */
  phone?: string;
  /** phone prefix (digits typed so far) */
  phonePrefix?: string;
};

/**
 * Turns the free-text search box into index-friendly predicates (never a leading-wildcard LIKE).
 * "DLV-000123" / "123" → number; "+380671234567" / "0671234567" → exact phone; "+38067", "38067" → phone prefix.
 */
export function searchIntent(q: string): SearchIntent {
  const t = q.trim();
  const intent: SearchIntent = {};
  const num = /^(?:dlv-?)?(\d{1,9})$/i.exec(t);
  if (num) intent.number = Number(num[1]);
  const phone = normalizePhone(t);
  if (phone) intent.phone = phone;
  const digits = t.replace(/[^\d]/g, '');
  // Also a prefix search, even when the text already parses as a complete number: "+3805011100" is both
  // a valid-looking phone and the start of several longer ones the sender is looking for.
  if (digits.length >= 4 && /^[+\d\s\-().]+$/.test(t)) {
    const d = digits.startsWith('0') ? `380${digits.slice(1)}` : digits;
    intent.phonePrefix = `+${d}`;
  }
  return intent;
}

/** Escapes LIKE metacharacters so user input is only ever a literal prefix. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
