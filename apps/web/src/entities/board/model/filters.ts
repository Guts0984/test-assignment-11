import { ZONES, type Zone } from '@courier/shared';

export type BoardStatusFilter = '' | 'created' | 'failed_attempt';
export type BoardShiftFilter = 'all' | 'on' | 'off';
export type BoardFilters = {
  zone: '' | Zone;
  status: BoardStatusFilter;
  q: string;
  shift: BoardShiftFilter;
  free: boolean;
};

export const EMPTY_BOARD_FILTERS: BoardFilters = {
  zone: '',
  status: '',
  q: '',
  shift: 'all',
  free: false,
};

/** Reads the filters from the URL. An unknown or hand-edited value falls back to the default instead of failing. */
export function parseBoardFilters(sp: URLSearchParams): BoardFilters {
  const zone = sp.get('zone');
  const status = sp.get('status');
  const shift = sp.get('shift');
  return {
    zone: ZONES.find((z) => z === zone) ?? '',
    status: status === 'created' || status === 'failed_attempt' ? status : '',
    q: (sp.get('q') ?? '').slice(0, 64),
    shift: shift === 'on' || shift === 'off' ? shift : 'all',
    free: sp.get('free') === '1',
  };
}

/** Only the non-default filters, so the URL (and the API call) stays clean. */
export function boardFilterParams(f: BoardFilters): [string, string][] {
  const out: [string, string][] = [];
  if (f.zone) out.push(['zone', f.zone]);
  if (f.status) out.push(['status', f.status]);
  if (f.q.trim()) out.push(['q', f.q.trim()]);
  if (f.shift !== 'all') out.push(['shift', f.shift]);
  if (f.free) out.push(['free', '1']);
  return out;
}
