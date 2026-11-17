'use client';
import { useTranslations } from 'next-intl';
import { WebhookForm } from '@/features/webhook-settings';

export function SenderSettingsPage() {
  const t = useTranslations('settings');
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="max-w-xl text-sm text-slate-700">{t('intro')}</p>
      <WebhookForm />
    </main>
  );
}
