import type { DeliveryStatus } from '@courier/shared';
import { DELIVERY_STATUSES } from '@courier/shared';

export type ListFilters = {
  q: string;
  status: DeliveryStatus[];
  from: string;
  to: string;
  page: number;
};
export const EMPTY_FILTERS: ListFilters = { q: '', status: [], from: '', to: '', page: 1 };

type Params = { get(k: string): string | null; getAll(k: string): string[] };

/** URL → filters. Anything invalid is dropped silently, so a hand-edited URL never breaks the page. */
export function filtersFromParams(p: Params): ListFilters {
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const page = Number(p.get('page') ?? 1);
  return {
    q: (p.get('q') ?? '').slice(0, 64),
    status: p
      .getAll('status')
      .filter((s): s is DeliveryStatus => (DELIVERY_STATUSES as readonly string[]).includes(s)),
    from: date(p.get('from')),
    to: date(p.get('to')),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** filters → query string (empty values and page 1 are omitted so URLs stay short and stable). */
export function filtersToQuery(f: ListFilters): string {
  const sp = new URLSearchParams();
  if (f.q.trim()) sp.set('q', f.q.trim());
  for (const s of f.status) sp.append('status', s);
  if (f.from) sp.set('from', f.from);
  if (f.to) sp.set('to', f.to);
  if (f.page > 1) sp.set('page', String(f.page));
  return sp.toString();
}
