'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, Spinner } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { useRealtimeInvalidate } from '@/shared/api';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib';
import { filtersFromParams, filtersToQuery, type ListFilters } from '@/shared/lib';
import { fetchList, deliveryKeys, PAGE_SIZE, StatusBadge } from '@/entities/delivery';
import { FiltersBar } from '@/features/delivery-filters';

export function DeliveryList({ scope }: { scope: 'sender' | 'dispatcher' }) {
  const t = useTranslations('list');
  const locale = useLocale() as AppLocale;
  const errorText = useErrorText();
  const router = useRouter();
  const path = usePathname() ?? '';
  const sp = useSearchParams() ?? new URLSearchParams();
  const filters = useMemo(() => filtersFromParams(sp), [sp]);
  const query = filtersToQuery(filters);
  const base = scope === 'sender' ? '/sender' : '/dispatcher/deliveries';

  const q = useQuery({
    queryKey: deliveryKeys.list(scope, query),
    queryFn: () => fetchList(scope, query),
    placeholderData: keepPreviousData,
  });
  useRealtimeInvalidate(['deliveries'], [['deliveries', 'list']]);

  const apply = (f: ListFilters) => {
    const qs = filtersToQuery(f);
    router.push(qs ? `${path}?${qs}` : path); // push, not replace: "Back" returns to the previous filters
  };
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <FiltersBar value={filters} onApply={apply} />
      {q.isError && <Alert>{errorText(q.error)}</Alert>}
      {q.isLoading && <Spinner label={t('loading')} />}
      {q.data && (
        <>
          <p className="text-sm text-slate-700" aria-live="polite" data-testid="total">
            {t('total', { count: q.data.total })}
          </p>
          {q.data.items.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
              {t('empty')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{t('caption')}</caption>
                <thead className="bg-slate-50 text-xs uppercase text-slate-600">
                  <tr>
                    <th scope="col" className="px-3 py-2">
                      {t('number')}
                    </th>
                    <th scope="col" className="px-3 py-2">
                      {t('status')}
                    </th>
                    <th scope="col" className="px-3 py-2">
                      {t('recipient')}
                    </th>
                    <th scope="col" className="px-3 py-2">
                      {t('zone')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      {t('total_price')}
                    </th>
                    <th scope="col" className="px-3 py-2">
                      {t('created')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((d) => (
                    <tr key={d.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">
                        <Link
                          className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
                          href={`${base}/${d.id}`}
                        >
                          {d.number}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={d.status} />
                      </td>
                      <td className="px-3 py-2">
                        {d.recipientName}
                        <span className="block text-xs text-slate-600">{d.recipientPhone}</span>
                      </td>
                      <td className="px-3 py-2">{d.zone}</td>
                      <td className="px-3 py-2 text-right">{formatMoney(d.totalKop, locale)}</td>
                      <td className="px-3 py-2">{formatDateTime(d.createdAt, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label={t('pagination')} className="flex items-center justify-between">
            <Button
              variant="secondary"
              disabled={filters.page <= 1}
              onClick={() => apply({ ...filters, page: filters.page - 1 })}
            >
              {t('prev')}
            </Button>
            <span className="text-sm" data-testid="page-info">
              {t('page', { page: filters.page, pages })}
            </span>
            <Button
              variant="secondary"
              disabled={filters.page >= pages}
              onClick={() => apply({ ...filters, page: filters.page + 1 })}
            >
              {t('next')}
            </Button>
          </nav>
        </>
      )}
    </div>
  );
}
