'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DeliveryList } from '@/widgets/delivery-list';

export function SenderListPage() {
  const t = useTranslations('list');
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('titleSender')}</h1>
        <Link
          href="/sender/new"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          {t('new')}
        </Link>
      </div>
      <DeliveryList scope="sender" />
    </main>
  );
}
