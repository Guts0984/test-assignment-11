'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, Spinner, TextField } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import {
  formatDuration,
  formatMoney,
  inclusiveDays,
  isCompleteDate,
  type AppLocale,
} from '@/shared/lib';
import { deliveryKeys } from '@/entities/delivery';
import { fetchReport } from '@/entities/board';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const MAX_DAYS = 366;

export function ReportView() {
  const t = useTranslations('report');
  const tr = useTranslations('reason');
  const locale = useLocale() as AppLocale;
  const errorText = useErrorText();
  const router = useRouter();
  const path = usePathname() ?? '';
  const sp = useSearchParams() ?? new URLSearchParams();
  // a missing param falls back to the default period; a present-but-bad one (2026-02-30) is kept so it can be reported
  const to = sp.get('to') ?? isoDay(new Date());
  const from = sp.get('from') ?? isoDay(new Date(Date.now() - 89 * 86_400_000));
  const [draft, setDraft] = useState({ from, to });
  const [errors, setErrors] = useState<{ from?: string; to?: string }>({});
  useEffect(() => {
    setDraft({ from, to }); // browser back/forward changes the URL → refresh the inputs
    setErrors({});
  }, [from, to]);

  /** Client-side period check, so the user sees which field is wrong instead of a generic server error. */
  const validate = (f: string, t2: string): { from?: string; to?: string } => {
    const e: { from?: string; to?: string } = {};
    if (!isCompleteDate(f)) e.from = t('errInvalidDate');
    if (!isCompleteDate(t2)) e.to = t('errInvalidDate');
    if (e.from || e.to) return e;
    if (f > t2) e.from = t('errFromAfterTo');
    else if (inclusiveDays(f, t2) > MAX_DAYS) e.to = t('errTooLong');
    return e;
  };
  const urlErrors = validate(from, to);
  const urlInvalid = !!(urlErrors.from || urlErrors.to);
  // a bad period that came from the URL is shown on its field until the user edits the inputs
  const fieldErrors =
    draft.from === from && draft.to === to && urlInvalid ? { ...urlErrors, ...errors } : errors;
  const q = useQuery({
    queryKey: deliveryKeys.report(from, to),
    queryFn: () => fetchReport(from, to),
    enabled: !urlInvalid, // a hand-edited URL with a bad period never reaches the server
  });

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t('period')}
        onSubmit={(e) => {
          e.preventDefault();
          const found = validate(draft.from, draft.to);
          setErrors(found);
          if (found.from || found.to) {
            document.getElementById(found.from ? 'report-from' : 'report-to')?.focus();
            return;
          }
          router.push(`${path}?from=${draft.from}&to=${draft.to}`);
        }}
      >
        <TextField
          id="report-from"
          label={t('from')}
          type="date"
          value={draft.from}
          error={fieldErrors.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
        <TextField
          id="report-to"
          label={t('to')}
          type="date"
          value={draft.to}
          error={fieldErrors.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
        <Button type="submit">{t('show')}</Button>
      </form>
      {q.isLoading && <Spinner label={t('loading')} />}
      {q.isError && <Alert>{errorText(q.error)}</Alert>}
      {q.data && (
        <div className="grid gap-6 md:grid-cols-2" data-testid="report">
          <section aria-labelledby="r1" className="rounded-md border border-slate-200 bg-white p-4">
            <h2 id="r1" className="mb-2 text-sm font-semibold">
              {t('delivered')}
            </h2>
            <p className="text-3xl font-semibold" data-testid="delivered-count">
              {q.data.delivered.count}
            </p>
            <p className="text-sm text-slate-600">
              {t('avgTime')}:{' '}
              <strong data-testid="avg-time">
                {formatDuration(q.data.delivered.avgAssignToDeliverSeconds, locale)}
              </strong>
            </p>
          </section>
          <section aria-labelledby="r2" className="rounded-md border border-slate-200 bg-white p-4">
            <h2 id="r2" className="mb-2 text-sm font-semibold">
              {t('failed', { count: q.data.failedAttempts.total })}
            </h2>
            <ul className="text-sm">
              {q.data.failedAttempts.byReason.map((r) => (
                <li key={r.reason} className="flex justify-between border-b border-slate-100 py-1">
                  <span>{tr(r.reason as never)}</span>
                  <span>{r.count}</span>
                </li>
              ))}
            </ul>
          </section>
          <section
            aria-labelledby="r3"
            className="rounded-md border border-slate-200 bg-white p-4 md:col-span-2"
          >
            <h2 id="r3" className="mb-2 text-sm font-semibold">
              {t('cash', { count: q.data.cashDiscrepancies.shifts })}
            </h2>
            <p className="mb-2 text-sm text-slate-600">
              {t('cashTotal')}:{' '}
              <strong>{formatMoney(q.data.cashDiscrepancies.totalKop, locale)}</strong>
            </p>
            {q.data.cashDiscrepancies.items.length === 0 ? (
              <p className="text-sm text-slate-600">{t('noDiscrepancies')}</p>
            ) : (
              <div
                className="max-h-96 overflow-auto"
                tabIndex={0}
                role="region"
                aria-label={t('cashRegion')}
              >
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">{t('cashTable')}</caption>
                  <thead className="text-xs uppercase text-slate-600">
                    <tr>
                      <th scope="col" className="py-1">
                        {t('courier')}
                      </th>
                      <th scope="col">{t('expected')}</th>
                      <th scope="col">{t('handed')}</th>
                      <th scope="col" className="text-right">
                        {t('difference')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.cashDiscrepancies.items.map((i) => (
                      <tr key={i.shiftId} className="border-t border-slate-100">
                        <td className="py-1">{i.courierName}</td>
                        <td>{formatMoney(i.expectedKop, locale)}</td>
                        <td>{formatMoney(i.handedKop, locale)}</td>
                        <td className="text-right">{formatMoney(i.discrepancyKop, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
