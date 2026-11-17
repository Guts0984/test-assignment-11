'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DELIVERY_STATUSES, type DeliveryStatus } from '@courier/shared';
import { Button, TextField } from '@/shared/ui';
import { EMPTY_FILTERS, isCompleteDate, type ListFilters } from '@/shared/lib';

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
  const applied = useRef(value); // what the URL currently holds
  const latest = useRef(value); // the newest draft, so two quick changes never read a stale one
  useEffect(() => {
    latest.current = value;
    applied.current = value;
    setDraft(value);
  }, [value]); // browser back/forward changes the URL → refresh the inputs
  const update = (next: ListFilters) => {
    latest.current = next;
    setDraft(next);
  };

  const badRange = (f: ListFilters) =>
    isCompleteDate(f.from) && isCompleteDate(f.to) && f.to < f.from;
  /** Never push a reversed range: keep what the URL holds for the dates, the rest of the draft still applies. */
  const sane = (f: ListFilters): ListFilters =>
    badRange(f) ? { ...f, from: applied.current.from, to: applied.current.to } : f;

  const toggle = (s: DeliveryStatus) => {
    const cur = latest.current;
    const next = {
      ...cur,
      page: 1,
      status: cur.status.includes(s) ? cur.status.filter((x) => x !== s) : [...cur.status, s],
    };
    update(next); // the checkbox responds at once; the URL follows
    const out = sane(next);
    applied.current = out;
    onApply(out);
  };

  // A date typed with the keyboard passes through half-valid values: keep them in the draft,
  // but touch the URL only for a cleared or complete valid date (and never lose the other date).
  const changeDate = (key: 'from' | 'to', v: string) => {
    const next = { ...latest.current, [key]: v, page: 1 };
    update(next);
    if (v === '' ? applied.current[key] === '' : !isCompleteDate(v)) return; // nothing to apply yet
    if (badRange(next)) return; // the error under "To" explains it; the typed text stays
    const other = key === 'from' ? 'to' : 'from';
    const o = next[other];
    const out = { ...next, [other]: o === '' || isCompleteDate(o) ? o : applied.current[other] };
    applied.current = out;
    onApply(out);
  };

  return (
    <form
      role="search"
      aria-label={t('label')}
      className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const out = sane({ ...latest.current, page: 1 });
        applied.current = out;
        onApply(out);
      }}
    >
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto]">
        <TextField
          label={t('search')}
          value={draft.q}
          onChange={(e) => update({ ...latest.current, q: e.target.value })}
          placeholder="DLV-000123 / +380…"
          maxLength={64}
        />
        <TextField
          label={t('from')}
          type="date"
          value={draft.from}
          onChange={(e) => changeDate('from', e.target.value)}
        />
        <TextField
          label={t('to')}
          type="date"
          value={draft.to}
          error={badRange(draft) ? t('errToBeforeFrom') : undefined}
          onChange={(e) => changeDate('to', e.target.value)}
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
