'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DELIVERY_STATUSES, type DeliveryStatus } from '@courier/shared';
import { Button, TextField } from '@/shared/ui';
import { EMPTY_FILTERS, type ListFilters } from '@/shared/lib';

/** The URL is the single source of truth: this bar only edits a draft and pushes it. "Back" restores the previous one. */
export function FiltersBar({
  value,
  onApply,
}: {
  value: ListFilters;
  onApply: (f: ListFilters) => void;
}) {
  const t = useTranslations('filters');
  const ts = useTranslations('status');
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]); // browser back/forward changes the URL → refresh the inputs

  const toggle = (s: DeliveryStatus) => {
    const next = {
      ...draft,
      page: 1,
      status: draft.status.includes(s) ? draft.status.filter((x) => x !== s) : [...draft.status, s],
    };
    setDraft(next); // the checkbox responds at once; the URL follows
    onApply(next);
  };

  return (
    <form
      role="search"
      aria-label={t('label')}
      className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onApply({ ...draft, page: 1 });
      }}
    >
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto]">
        <TextField
          label={t('search')}
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          placeholder="DLV-000123 / +380…"
          maxLength={64}
        />
        <TextField
          label={t('from')}
          type="date"
          value={draft.from}
          onChange={(e) => onApply({ ...draft, from: e.target.value, page: 1 })}
        />
        <TextField
          label={t('to')}
          type="date"
          value={draft.to}
          onChange={(e) => onApply({ ...draft, to: e.target.value, page: 1 })}
        />
        <div className="flex items-end gap-2">
          <Button type="submit">{t('apply')}</Button>
          <Button variant="secondary" onClick={() => onApply(EMPTY_FILTERS)}>
            {t('reset')}
          </Button>
        </div>
      </div>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
        <legend className="mb-1 text-sm font-medium">{t('status')}</legend>
        {DELIVERY_STATUSES.map((s) => (
          <label key={s} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={draft.status.includes(s)} onChange={() => toggle(s)} />
            {ts(s)}
          </label>
        ))}
      </fieldset>
    </form>
  );
}
