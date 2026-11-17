'use client';
import { useTranslations } from 'next-intl';
import { DeliveryList } from '@/widgets/delivery-list';

export function DispatcherListPage() {
  const t = useTranslations('list');
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-xl font-semibold">{t('titleDispatcher')}</h1>
      <DeliveryList scope="dispatcher" />
    </main>
  );
}
