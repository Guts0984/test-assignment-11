'use client';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { getSupabase } from '@/shared/api';
import { Button } from '@/shared/ui';

export function SignOutButton() {
  const t = useTranslations('nav');
  const router = useRouter();
  const qc = useQueryClient();
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        await getSupabase().auth.signOut();
        qc.clear(); // nothing of the previous user may stay in memory
        router.replace('/login');
        router.refresh();
      }}
    >
      {t('signOut')}
    </Button>
  );
}
