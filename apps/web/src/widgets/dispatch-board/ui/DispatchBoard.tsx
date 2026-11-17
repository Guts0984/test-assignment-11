'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, Spinner } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { useRealtimeInvalidate } from '@/shared/api';
import { formatDateTime, type AppLocale } from '@/shared/lib';
import { fetchBoard, type BoardCourier } from '@/entities/board';
import { deliveryKeys, StatusBadge } from '@/entities/delivery';
import { AssignDialog } from '@/features/assign-delivery';
import { CloseShiftDialog } from '@/features/close-shift';
import { UnblockButton } from '@/features/unblock-handover';

export function DispatchBoard() {
  const t = useTranslations('board');
  const locale = useLocale() as AppLocale;
  const errorText = useErrorText();
  const board = useQuery({ queryKey: deliveryKeys.board, queryFn: fetchBoard });
  // the board updates by itself whenever a courier does something (RLS-filtered Realtime)
  useRealtimeInvalidate(['deliveries', 'shifts', 'assignments'], [deliveryKeys.board]);
  const [target, setTarget] = useState<{ id: string; number: string; status: string } | null>(null);
  const [closing, setClosing] = useState<BoardCourier | null>(null);

  if (board.isLoading) return <Spinner label={t('loading')} />;
  if (board.isError) return <Alert>{errorText(board.error)}</Alert>;
  const b = board.data!;

  return (
    <div className="flex flex-col gap-8">
      {b.blocked.length > 0 && (
        <section
          aria-labelledby="sec-blocked"
          className="rounded-md border border-red-300 bg-red-50 p-4"
        >
          <h2 id="sec-blocked" className="mb-2 text-sm font-semibold text-red-900">
            {t('blocked')}
          </h2>
          <ul className="flex flex-col gap-2">
            {b.blocked.map((x) => (
              <li
                key={x.id}
                className="flex flex-wrap items-center gap-3 text-sm"
                data-testid="blocked-item"
              >
                <Link className="font-medium underline" href={`/dispatcher/deliveries/${x.id}`}>
                  {x.number}
                </Link>
                <span>{x.courierName ?? '–'}</span>
                <UnblockButton id={x.id} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="sec-queue">
        <h2 id="sec-queue" className="mb-3 text-lg font-semibold">
          {t('queue')}
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {b.zones.map((z) => (
            <div
              key={z.zone}
              className="rounded-md border border-slate-200 bg-white p-3"
              data-testid={`zone-${z.zone}`}
            >
              <h3 className="mb-2 flex items-baseline justify-between text-sm font-semibold">
                <span>{t('zone', { zone: z.zone })}</span>
                <span className="text-slate-600">{t('waiting', { count: z.waiting })}</span>
              </h3>
              {z.items.length === 0 ? (
                <p className="text-sm text-slate-600">{t('emptyQueue')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {z.items.map((i) => (
                    <li
                      key={i.id}
                      className="flex items-center justify-between gap-2 rounded border border-slate-100 p-2 text-sm"
                      data-testid="queue-item"
                    >
                      <span>
                        <Link
                          className="font-medium underline"
                          href={`/dispatcher/deliveries/${i.id}`}
                        >
                          {i.number}
                        </Link>
                        <span className="ml-2">
                          <StatusBadge status={i.status} />
                        </span>
                        <span className="block text-xs text-slate-600">
                          {i.recipientName}
                          {!i.assignable && i.nextAttemptAt
                            ? ` · ${t('notBefore', { date: formatDateTime(i.nextAttemptAt, locale) })}`
                            : ''}
                        </span>
                      </span>
                      <Button
                        variant="secondary"
                        aria-label={t('assignFor', { number: i.number })}
                        onClick={() => setTarget({ id: i.id, number: i.number, status: i.status })}
                      >
                        {t('assign')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="sec-couriers">
        <h2 id="sec-couriers" className="mb-3 text-lg font-semibold">
          {t('couriers')}
        </h2>
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t('couriers')}</caption>
            <thead className="bg-slate-50 text-xs uppercase text-slate-600">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {t('courier')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('load')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('shift')}
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">{t('actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {b.couriers.map((c) => (
                <tr key={c.id} className="border-t border-slate-100" data-testid="courier-row">
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2" data-testid="load">
                    {c.active}/{c.limit}
                  </td>
                  <td className="px-3 py-2">{c.onShift ? t('onShift') : t('offShift')}</td>
                  <td className="px-3 py-2 text-right">
                    {c.onShift && (
                      <Button
                        variant="secondary"
                        aria-label={t('closeShiftFor', { name: c.name })}
                        onClick={() => setClosing(c)}
                      >
                        {t('closeShift')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <AssignDialog delivery={target} couriers={b.couriers} onClose={() => setTarget(null)} />
      <CloseShiftDialog courier={closing} onClose={() => setClosing(null)} />
    </div>
  );
}
