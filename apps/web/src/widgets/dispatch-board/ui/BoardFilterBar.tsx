'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ZONES } from '@courier/shared';
import { SelectField, TextField, Button } from '@/shared/ui';
import {
  boardFilterParams,
  EMPTY_BOARD_FILTERS,
  type BoardFilters,
  type BoardShiftFilter,
  type BoardStatusFilter,
} from '@/entities/board';

const FILTER_KEYS = ['zone', 'status', 'q', 'shift', 'free'];

/** The URL holds the filters (Back restores the previous ones); this bar only edits the search draft and pushes. */
export function BoardFilterBar({ filters }: { filters: BoardFilters }) {
  const t = useTranslations('board');
  const ts = useTranslations('status');
  const router = useRouter();
  const path = usePathname() ?? '';
  const sp = useSearchParams() ?? new URLSearchParams();
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]); // browser back/forward changes the URL

  /** Writes the filters to the URL with push, keeping other params (order) and omitting defaults. */
  const push = (next: BoardFilters) => {
    const params = new URLSearchParams(sp.toString());
    FILTER_KEYS.forEach((k) => params.delete(k));
    boardFilterParams(next).forEach(([k, v]) => params.set(k, v));
    const qs = params.toString();
    router.push(qs ? `${path}?${qs}` : path);
  };
  const active = boardFilterParams(filters).length > 0 || q !== '';

  return (
    <form
      role="search"
      aria-label={t('filtersLabel')}
      className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-3"
      onSubmit={(e) => {
        e.preventDefault();
        push({ ...filters, q: q.trim() });
      }}
    >
      <SelectField
        label={t('filterZone')}
        value={filters.zone}
        onChange={(e) => push({ ...filters, zone: e.target.value as BoardFilters['zone'] })}
      >
        <option value="">{t('filterAll')}</option>
        {ZONES.map((z) => (
          <option key={z} value={z}>
            {t('zone', { zone: z })}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('filterStatus')}
        value={filters.status}
        onChange={(e) => push({ ...filters, status: e.target.value as BoardStatusFilter })}
      >
        <option value="">{t('filterAll')}</option>
        <option value="created">{ts('created')}</option>
        <option value="failed_attempt">{ts('failed_attempt')}</option>
      </SelectField>
      <TextField
        label={t('filterSearch')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="DLV-000123 / +380…"
        maxLength={64}
        hint={t('filterSearchHint')}
      />
      <SelectField
        label={t('filterShift')}
        value={filters.shift}
        onChange={(e) => push({ ...filters, shift: e.target.value as BoardShiftFilter })}
      >
        <option value="all">{t('filterAll')}</option>
        <option value="on">{t('onShift')}</option>
        <option value="off">{t('offShift')}</option>
      </SelectField>
      <label className="flex min-h-10 items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          checked={filters.free}
          onChange={(e) => push({ ...filters, free: e.target.checked })}
        />
        {t('filterFree')}
      </label>
      {active && (
        <Button variant="secondary" onClick={() => push(EMPTY_BOARD_FILTERS)}>
          {t('filterReset')}
        </Button>
      )}
    </form>
  );
}
