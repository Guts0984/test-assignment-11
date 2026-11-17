'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, SelectField, Spinner } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { formatDateTime, type AppLocale } from '@/shared/lib';
import { deliveryKeys, PAGE_SIZE } from '@/entities/delivery';
import { fetchNotification, fetchNotifications } from '@/entities/notification';
import { ResendButton } from '@/features/resend-notification';

function AttemptLog({ id }: { id: string }) {
  const t = useTranslations('notifications');
  const locale = useLocale() as AppLocale;
  const q = useQuery({
    queryKey: ['notifications', 'one', id],
    queryFn: () => fetchNotification(id),
  });
  if (q.isLoading) return <Spinner label={t('loading')} />;
  return (
    <ul className="mt-2 flex flex-col gap-1 text-xs text-slate-700">
      {(q.data?.attemptLog ?? []).map((a) => (
        <li key={a.id}>
          {formatDateTime(a.attemptedAt, locale)} · {a.httpStatus ?? '–'} · {a.error ?? 'OK'}{' '}
          {a.manual ? `· ${t('manual')}` : ''}
        </li>
      ))}
    </ul>
  );
}

export function NotificationsLog() {
  const t = useTranslations('notifications');
  const te = useTranslations('event');
  const locale = useLocale() as AppLocale;
  const errorText = useErrorText();
  const router = useRouter();
  const path = usePathname() ?? '';
  const sp = useSearchParams() ?? new URLSearchParams();
  const status =
    sp.get('status') === 'pending' || sp.get('status') === 'delivered' ? sp.get('status')! : '';
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const qs = new URLSearchParams({
    ...(status ? { status } : {}),
    page: String(page),
    pageSize: String(PAGE_SIZE),
  }).toString();
  const q = useQuery({
    queryKey: deliveryKeys.notifications(qs),
    queryFn: () => fetchNotifications(qs),
    refetchInterval: 5000,
  });
  const go = (next: { status?: string; page?: number }) => {
    const p = new URLSearchParams();
    const s = next.status ?? status;
    if (s) p.set('status', s);
    if ((next.page ?? page) > 1) p.set('page', String(next.page ?? page));
    router.push(p.toString() ? `${path}?${p}` : path);
  };
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label={t('filter')}
        value={status}
        onChange={(e) => go({ status: e.target.value, page: 1 })}
        className="max-w-xs"
      >
        <option value="">{t('all')}</option>
        <option value="pending">{t('pending')}</option>
        <option value="delivered">{t('delivered')}</option>
      </SelectField>
      {q.isError && <Alert>{errorText(q.error)}</Alert>}
      {q.isLoading && <Spinner label={t('loading')} />}
      {q.data && q.data.items.length === 0 && (
        <p className="text-sm text-slate-600">{t('empty')}</p>
      )}
      <ul className="flex flex-col gap-2">
        {q.data?.items.map((n) => (
          <li
            key={n.id}
            className="rounded-md border border-slate-200 bg-white p-3 text-sm"
            data-testid="notification"
          >
            <div className="flex flex-wrap items-center gap-3">
              <strong>{n.number}</strong>
              <span>{te(n.eventType as never)}</span>
              <span className={n.status === 'delivered' ? 'text-green-700' : 'text-amber-700'}>
                {t(n.status)}
              </span>
              <span className="text-slate-600">{t('attempts', { count: n.attempts })}</span>
              {n.status === 'pending' && n.nextAttemptAt && (
                <span className="text-slate-600">
                  {t('nextTry', { date: formatDateTime(n.nextAttemptAt, locale) })}
                </span>
              )}
              {n.lastError && <span className="text-red-700">{n.lastError}</span>}
              <span className="ml-auto">
                <ResendButton id={n.id} />
              </span>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-slate-700">{t('log')}</summary>
              <AttemptLog id={n.id} />
            </details>
          </li>
        ))}
      </ul>
      <nav aria-label={t('pagination')} className="flex items-center justify-between">
        <Button variant="secondary" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>
          {t('prev')}
        </Button>
        <span className="text-sm">{t('page', { page, pages })}</span>
        <Button variant="secondary" disabled={page >= pages} onClick={() => go({ page: page + 1 })}>
          {t('next')}
        </Button>
      </nav>
    </div>
  );
}
