'use client';
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import type { DeliveryStatus } from '@courier/shared';
import { Alert, Spinner } from '@/shared/ui';
import { api, isApiError } from '@/shared/api';
import { useTrackingBroadcast } from '@/shared/api';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib';
import { StatusBadge } from '@/entities/delivery';

type View = {
  number: string;
  status: DeliveryStatus;
  attemptNo: number;
  courierName: string | null;
  amountDueKop: number;
  code: string;
  channel: string;
  city: string;
  street: string;
  phoneMasked: string;
  updatedAt: string;
  timeline: { status: DeliveryStatus; at: string }[];
};

/** Public page: no login. Initial data from the API, then live updates over an anonymous Broadcast channel. */
export function TrackingCard({ token }: { token: string }) {
  const t = useTranslations('track');
  const locale = useLocale() as AppLocale;
  const qc = useQueryClient();
  const key = ['tracking', token];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<View>(`/tracking/${token}`, { anonymous: true }),
    retry: false,
  });
  // The broadcast channel is public (anyone who knows the unguessable name can also SEND to it), so its payload is never
  // shown. A message only means "something changed": the page then asks the API, which is the source of truth.
  // Messages are coalesced: at most one refetch per 2 s, so someone flooding the public channel cannot make the page
  // hammer the API (and get rate limited).
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useTrackingBroadcast(q.data?.channel, () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void qc.invalidateQueries({ queryKey: key });
    }, 2000);
  });
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );

  if (q.isLoading) return <Spinner label={t('loading')} />;
  // a failed REFETCH (e.g. rate limited) must not replace a page that is already showing data
  if (q.isError && !q.data)
    return (
      <Alert>{isApiError(q.error) && q.error.status === 404 ? t('notFound') : t('error')}</Alert>
    );
  const d = q.data!;
  return (
    <article className="mx-auto flex max-w-md flex-col gap-5" aria-labelledby="tr-title">
      <header>
        <p className="text-sm text-slate-600">{t('delivery')}</p>
        <h1 id="tr-title" className="text-2xl font-semibold" data-testid="tr-number">
          {d.number}
        </h1>
      </header>
      <div className="flex items-center gap-3" aria-live="polite">
        <span data-testid="tr-status">
          <StatusBadge status={d.status} />
        </span>
        <span className="text-sm text-slate-700" data-testid="tr-attempt">
          {t('attempt', { n: d.attemptNo })}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-slate-600">{t('courier')}</dt>
        <dd data-testid="tr-courier">{d.courierName ?? t('noCourier')}</dd>
        <dt className="text-slate-600">{t('toPay')}</dt>
        <dd className="font-semibold" data-testid="tr-amount">
          {formatMoney(d.amountDueKop, locale)}
        </dd>
        <dt className="text-slate-600">{t('where')}</dt>
        <dd>
          {d.city}, {d.street}
        </dd>
        <dt className="text-slate-600">{t('phone')}</dt>
        <dd>{d.phoneMasked}</dd>
      </dl>
      <section
        className="rounded-lg border-2 border-slate-900 p-4 text-center"
        aria-labelledby="tr-code-h"
      >
        <h2 id="tr-code-h" className="text-sm text-slate-700">
          {t('code')}
        </h2>
        <p className="text-4xl font-bold tracking-widest" data-testid="tr-code">
          {d.code}
        </p>
        <p className="mt-1 text-xs text-slate-600">{t('codeHint')}</p>
      </section>
      <ol
        className="flex flex-col gap-1 border-l-2 border-slate-200 pl-4 text-sm"
        aria-label={t('timeline')}
      >
        {d.timeline.map((e, i) => (
          <li key={`${e.status}-${i}`}>
            <StatusBadge status={e.status} />{' '}
            <span className="text-xs text-slate-600">{formatDateTime(e.at, locale)}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}
