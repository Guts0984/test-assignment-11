'use client';
import { useTranslations } from 'next-intl';
import { LoginForm } from '@/features/sign-in';

export function LoginPage() {
  const t = useTranslations('login');
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-12">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <LoginForm />
    </main>
  );
}
