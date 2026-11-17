'use client';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Alert, Spinner } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { useRealtimeInvalidate } from '@/shared/api';
import { api } from '@/shared/api';
import { formatDateTime, formatMoney, formatWeight, type AppLocale } from '@/shared/lib';
import {
  deliveryKeys,
  fetchCard,
  fetchPhotos,
  StatusBadge,
  type CardDto,
} from '@/entities/delivery';

const reasonOf = (payload: Record<string, unknown>) =>
  typeof payload.reason === 'string' ? payload.reason : null;

export function DeliveryCard({
  id,
  viewer,
  actions,
}: {
  id: string;
  viewer: 'sender' | 'dispatcher';
  actions?: (c: CardDto) => ReactNode;
}) {
  const t = useTranslations('card');
  const te = useTranslations('event');
  const tr = useTranslations('reason');
  const locale = useLocale() as AppLocale;
  const errorText = useErrorText();
  const card = useQuery({ queryKey: deliveryKeys.card(id), queryFn: () => fetchCard(id) });
  const photos = useQuery({
    queryKey: deliveryKeys.photos(id),
    queryFn: () => fetchPhotos(id),
    enabled: (card.data?.photos.length ?? 0) > 0,
    staleTime: 120_000,
  });
  useRealtimeInvalidate(['deliveries'], [deliveryKeys.card(id)]);
  void api;

  if (card.isLoading) return <Spinner label={t('loading')} />;
  if (card.isError) return <Alert>{errorText(card.error)}</Alert>;
  const { delivery: d, events } = card.data!;
  const dispatcherView = viewer === 'dispatcher';
  const row = (label: string, value: ReactNode) => (
    <>
      <dt className="text-slate-600">{label}</dt>
      <dd>{value}</dd>
    </>
  );

  return (
    <article className="flex flex-col gap-6" aria-labelledby="card-title">
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="card-title" className="text-xl font-semibold" data-testid="number">
          {d.number}
        </h1>
        <StatusBadge status={d.status} />
        <span className="text-sm text-slate-600">{t('attempt', { n: d.attemptNo })}</span>
        <div className="ml-auto flex gap-2">{actions?.(card.data!)}</div>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="sec-details">
          <h2 id="sec-details" className="mb-2 text-sm font-semibold">
            {t('details')}
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {row(t('recipient'), `${d.recipientName}, ${d.recipientPhone}`)}
            {row(
              t('address'),
              `${d.address.city}, ${d.address.street} ${d.address.house}${d.address.apartment ? `, ${d.address.apartment}` : ''}`,
            )}
            {d.address.note && row(t('note'), d.address.note)}
            {row(t('zone'), d.zone)}
            {row(t('weight'), formatWeight(d.weightG, locale))}
            {row(t('cod'), formatMoney(d.codKop, locale))}
            {row(t('fee'), formatMoney(d.feeKop, locale))}
            {row(t('commission'), formatMoney(d.codCommissionKop, locale))}
            {row(t('total'), <strong>{formatMoney(d.totalKop, locale)}</strong>)}
            {d.courierName && row(t('courier'), d.courierName)}
            {dispatcherView && d.senderCompany && row(t('sender'), d.senderCompany)}
            {dispatcherView &&
              d.handoverBlocked &&
              row(t('handover'), <span className="font-medium text-red-700">{t('blocked')}</span>)}
            {d.nextAttemptAt && row(t('nextAttempt'), formatDateTime(d.nextAttemptAt, locale))}
            {row(t('createdAt'), formatDateTime(d.createdAt, locale))}
            {d.trackingToken &&
              row(
                t('tracking'),
                <a
                  className="break-all underline"
                  href={`/track/${d.trackingToken}`}
                  target="_blank"
                  rel="noreferrer"
                >{`/track/${d.trackingToken}`}</a>,
              )}
          </dl>
        </section>

        <section aria-labelledby="sec-photos">
          <h2 id="sec-photos" className="mb-2 text-sm font-semibold">
            {t('photos')}
          </h2>
          {card.data!.photos.length === 0 ? (
            <p className="text-sm text-slate-600">{t('noPhotos')}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3">
              {(photos.data?.items ?? []).map((p) => (
                <li key={p.id}>
                  {/* signed URL, valid for a few minutes only */}
                  <img
                    src={p.url}
                    alt={p.kind === 'handover' ? t('photoHandover') : t('photoFailed')}
                    className="aspect-square w-full rounded-md border object-cover"
                    loading="lazy"
                  />
                  <span className="text-xs text-slate-600">
                    {p.kind === 'handover' ? t('photoHandover') : t('photoFailed')}
                  </span>
                </li>
              ))}
              {photos.isLoading && (
                <li>
                  <Spinner label={t('loading')} />
                </li>
              )}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="sec-history">
        <h2 id="sec-history" className="mb-2 text-sm font-semibold">
          {t('history')}
        </h2>
        <ol className="flex flex-col gap-2 border-l-2 border-slate-200 pl-4" data-testid="history">
          {events.map((e) => {
            const reason = reasonOf(e.payload);
            return (
              <li key={e.id} className="text-sm">
                <span className="font-medium">{te(e.type as never)}</span>
                {reason && <span> · {tr(reason as never)}</span>}
                <span className="block text-xs text-slate-600">
                  {t('serverTime')}: {formatDateTime(e.serverTime, locale)}
                  {e.deviceTime && (
                    <>
                      {' '}
                      · {t('deviceTime')}: {formatDateTime(e.deviceTime, locale)}
                    </>
                  )}
                  {' · '}
                  {t('actor', { role: e.actorRole })}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </article>
  );
}
