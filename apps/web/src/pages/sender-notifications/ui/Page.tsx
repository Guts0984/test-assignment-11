'use client';
import { useTranslations } from 'next-intl';
import { NotificationsLog } from '@/widgets/notifications-log';

export function SenderNotificationsPage() {
  const t = useTranslations('notifications');
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <NotificationsLog />
    </main>
  );
}
