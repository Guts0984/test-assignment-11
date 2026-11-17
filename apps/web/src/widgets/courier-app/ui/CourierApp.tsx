'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import type { CourierAction } from '@courier/shared';
import { Alert, Badge, Button, Spinner } from '@/shared/ui';
import { isApiError, useRealtimeInvalidate } from '@/shared/api';
import { useCodeText, useErrorText } from '@/shared/i18n';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib';
import {
  fetchToday,
  openShift,
  type CourierDelivery,
  type Today,
} from '@/entities/courier-delivery';
import { overlayStatus, useCourierSync } from '@/features/courier-sync';
import { DeliverDialog, FailDialog, type Target } from '@/features/courier-actions';

const KEY = ['courier-today'];

export function CourierApp() {
  const t = useTranslations('courier');
  const ts = useTranslations('status');
  const locale = useLocale() as AppLocale;
  const errorText = useErrorText();
  const codeText = useCodeText();
  const qc = useQueryClient();
  const sync = useCourierSync(() => void qc.invalidateQueries({ queryKey: KEY }));
  const [deliverFor, setDeliverFor] = useState<Target | null>(null);
  const [failFor, setFailFor] = useState<Target | null>(null);
  const [shiftError, setShiftError] = useState<string | null>(null);

  const today = useQuery({
    queryKey: KEY,
    enabled: sync.ready,
    refetchInterval: sync.online ? 30_000 : false,
    queryFn: async (): Promise<Today> => {
      try {
        const data = await fetchToday();
        await sync.store.setMeta('today', data);
        return data;
      } catch (e) {
        // no connection: show what the device knew last time
        if (isApiError(e) && e.code === 'NETWORK') {
          const cached = await sync.store.getMeta<Today>('today');
          if (cached) return { ...cached, stale: true };
        }
        throw e;
      }
    },
  });
  // coming back online refreshes the list
  useEffect(() => {
    if (sync.online && sync.ready) void qc.invalidateQueries({ queryKey: KEY });
  }, [sync.online, sync.ready, qc]);
  useRealtimeInvalidate(['deliveries', 'assignments'], [KEY], sync.online);

  const queue = sync.state.queue;
  const rejected = queue.filter((q) => q.status === 'rejected');

  const queuePickup = (d: CourierDelivery) => {
    const a: CourierAction = {
      type: 'pickup',
      clientActionId: crypto.randomUUID(),
      deliveryId: d.id,
      deviceTime: new Date().toISOString(),
    };
    return sync.add(a, d.number);
  };
  const submitWithPhoto =
    (number: string) =>
    (a: CourierAction, photo: Parameters<Parameters<typeof DeliverDialog>[0]['onSubmit']>[1]) =>
      sync.add(a, number, photo);

  const doOpenShift = async () => {
    setShiftError(null);
    try {
      await openShift();
      void qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      setShiftError(errorText(e));
    }
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-3 py-4" data-testid="courier-app">
      <section
        aria-label={t('status')}
        className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white p-3 text-sm"
      >
        <span
          data-testid="net"
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${sync.online ? 'bg-green-100 text-green-900' : 'bg-amber-100 text-amber-900'}`}
        >
          {sync.online ? t('online') : t('offline')}
        </span>
        <span role="status" aria-live="polite" data-testid="waiting">
          {sync.waiting > 0 ? t('waiting', { count: sync.waiting }) : t('allSent')}
        </span>
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={!sync.online || sync.syncing}
          onClick={() => void sync.syncNow()}
        >
          {t('syncNow')}
        </Button>
        {sync.lastSync && (
          <span className="w-full text-xs text-slate-600">
            {t('lastSync', { date: formatDateTime(sync.lastSync, locale) })}
          </span>
        )}
      </section>

      {rejected.length > 0 && (
        <section
          aria-labelledby="rej"
          className="rounded-md border border-red-300 bg-red-50 p-3"
          data-testid="rejected"
        >
          <h2 id="rej" className="mb-2 text-sm font-semibold text-red-900">
            {t('rejectedTitle')}
          </h2>
          <ul className="flex flex-col gap-2">
            {rejected.map((q) => (
              <li key={q.clientActionId} className="text-sm" data-testid="rejected-item">
                <strong>{q.number}</strong> · {t(`action_${q.action.type}` as never)}
                <p>{codeText(q.reject?.code ?? 'INTERNAL', q.reject?.details)}</p>
                <Button variant="secondary" onClick={() => void sync.dismiss(q.clientActionId)}>
                  {t('dismiss')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {today.isLoading && <Spinner label={t('loading')} />}
      {today.isError && <Alert>{errorText(today.error)}</Alert>}
      {today.data?.stale && <Alert tone="info">{t('stale')}</Alert>}

      {today.data && (
        <>
          <section aria-label={t('shift')} className="flex items-center gap-3">
            {today.data.shift ? (
              <span className="text-sm text-slate-700">
                {t('shiftOpen', { date: formatDateTime(today.data.shift.openedAt, locale) })}
              </span>
            ) : (
              <>
                <span className="text-sm">{t('noShift')}</span>
                <Button onClick={() => void doOpenShift()} disabled={!sync.online}>
                  {t('openShift')}
                </Button>
              </>
            )}
          </section>
          {shiftError && <Alert>{shiftError}</Alert>}

          {today.data.removed.length > 0 && (
            <section
              aria-labelledby="rem"
              className="rounded-md border border-amber-300 bg-amber-50 p-3"
              data-testid="removed"
            >
              <h2 id="rem" className="mb-1 text-sm font-semibold">
                {t('removedTitle')}
              </h2>
              <ul className="text-sm">
                {today.data.removed.map((r) => (
                  <li key={r.deliveryId + r.endedAt}>
                    <strong>{r.number}</strong> · {t(`removed_${r.reason}` as never)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <h1 className="text-lg font-semibold">
            {t('today', { count: today.data.deliveries.length })}
          </h1>
          {today.data.deliveries.length === 0 && (
            <p className="text-sm text-slate-600">{t('empty')}</p>
          )}
          <ul className="flex flex-col gap-3">
            {today.data.deliveries.map((d) => {
              const view = overlayStatus(d.status, d.id, queue);
              const target: Target = { id: d.id, number: d.number, amountDueKop: d.amountDueKop };
              return (
                <li
                  key={d.id}
                  className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
                  data-testid="delivery"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong data-testid="d-number">{d.number}</strong>
                    <Badge status={view.status}>{ts(view.status as never)}</Badge>
                  </div>
                  <p className="mt-1 text-sm">
                    {d.address.city}, {d.address.street} {d.address.house}
                    {d.address.apartment ? `, ${d.address.apartment}` : ''}
                  </p>
                  {d.address.note && <p className="text-xs text-slate-600">{d.address.note}</p>}
                  <p className="text-sm">
                    {d.recipientName} ·{' '}
                    <a className="underline" href={`tel:${d.recipientPhone}`}>
                      {d.recipientPhone}
                    </a>
                  </p>
                  <p className="text-sm">
                    {t('amountDue')}: <strong>{formatMoney(d.amountDueKop, locale)}</strong> ·{' '}
                    {t('attempt', { n: d.attemptNo })}
                  </p>
                  {d.handoverBlocked && <Alert>{t('blocked')}</Alert>}
                  {view.waiting > 0 && (
                    <p className="mt-1 text-xs font-medium text-amber-800" data-testid="d-waiting">
                      {t('waitingForDelivery', { count: view.waiting })}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {view.status === 'assigned' && (
                      <Button className="flex-1" onClick={() => void queuePickup(d)}>
                        {t('pickup')}
                      </Button>
                    )}
                    {view.status === 'picked_up' && (
                      <>
                        <Button className="flex-1" onClick={() => setDeliverFor(target)}>
                          {t('deliver')}
                        </Button>
                        <Button
                          className="flex-1"
                          variant="secondary"
                          onClick={() => setFailFor(target)}
                        >
                          {t('fail')}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <DeliverDialog
        target={deliverFor}
        onClose={() => setDeliverFor(null)}
        onSubmit={submitWithPhoto(deliverFor?.number ?? '')}
      />
      <FailDialog
        target={failFor}
        onClose={() => setFailFor(null)}
        onSubmit={submitWithPhoto(failFor?.number ?? '')}
      />
    </div>
  );
}
