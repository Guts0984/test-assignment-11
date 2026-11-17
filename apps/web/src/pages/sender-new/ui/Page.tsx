'use client';
import { useTranslations } from 'next-intl';
import { CreateDeliveryForm } from '@/features/create-delivery';

export function SenderNewPage() {
  const t = useTranslations('create');
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <CreateDeliveryForm />
    </main>
  );
}
