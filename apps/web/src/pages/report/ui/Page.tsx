'use client';
import { useTranslations } from 'next-intl';
import { ReportView } from '@/widgets/report-view';

export function ReportPage() {
  const t = useTranslations('report');
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <ReportView />
    </main>
  );
}
