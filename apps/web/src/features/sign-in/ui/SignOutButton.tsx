'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { collectSignOutWarnings, getSupabase, runSignOutHooks } from '@/shared/api';
import { Button, Dialog } from '@/shared/ui';

export function SignOutButton() {
  const t = useTranslations('nav');
  const router = useRouter();
  const qc = useQueryClient();
  const [warnings, setWarnings] = useState<string[] | null>(null);

  const signOut = async () => {
    setWarnings(null);
    await runSignOutHooks(); // e.g. wipe personal data cached on this device
    const supabase = getSupabase();
    // Global sign-out revokes the session on the server; offline that fails, so still end this device's session.
    const { error } = await supabase.auth.signOut().catch(() => ({ error: new Error('offline') }));
    if (error) await supabase.auth.signOut({ scope: 'local' });
    qc.clear(); // nothing of the previous user may stay in memory
    router.replace('/login');
    router.refresh();
  };

  return (
    <>
      <Button
        variant="secondary"
        onClick={async () => {
          const found = await collectSignOutWarnings();
          if (found.length > 0) setWarnings(found);
          else await signOut();
        }}
      >
        {t('signOut')}
      </Button>
      <Dialog open={warnings !== null} onClose={() => setWarnings(null)} title={t('signOutTitle')}>
        {warnings?.map((w) => (
          <p key={w} className="text-sm">
            {w}
          </p>
        ))}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setWarnings(null)}>
            {t('signOutCancel')}
          </Button>
          <Button onClick={() => void signOut()}>{t('signOutAnyway')}</Button>
        </div>
      </Dialog>
    </>
  );
}
