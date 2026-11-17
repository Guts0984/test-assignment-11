'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, Spinner, TextField } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { formatDuration, formatMoney, type AppLocale } from '@/shared/lib';
import { deliveryKeys } from '@/entities/delivery';
import { fetchReport } from '@/entities/board';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function ReportView() {
  const t = useTranslations('report');
  const tr = useTranslations('reason');
  const locale = useLocale() as AppLocale;
  const errorText = useErrorText();
  const router = useRouter();
  const path = usePathname() ?? '';
  const sp = useSearchParams() ?? new URLSearchParams();
  const to = DATE.test(sp.get('to') ?? '') ? sp.get('to')! : isoDay(new Date());
  const from = DATE.test(sp.get('from') ?? '')
    ? sp.get('from')!
    : isoDay(new Date(Date.now() - 89 * 86_400_000));
  const [draft, setDraft] = useState({ from, to });
  const q = useQuery({
    queryKey: deliveryKeys.report(from, to),
    queryFn: () => fetchReport(from, to),
  });

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t('period')}
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`${path}?from=${draft.from}&to=${draft.to}`);
        }}
      >
        <TextField
          label={t('from')}
          type="date"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
        <TextField
          label={t('to')}
          type="date"
          value={draft.to}
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
              <div className="max-h-96 overflow-auto">
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
