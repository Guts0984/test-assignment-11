'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Button } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { resend } from '@/entities/notification';

export function ResendButton({ id }: { id: string }) {
  const t = useTranslations('notifications');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => resend(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button variant="secondary" disabled={m.isPending} onClick={() => m.mutate()}>
        {m.isPending ? t('resending') : t('resend')}
      </Button>
      {m.data && (
        <span
          role="status"
          className={`text-xs ${m.data.attempt.ok ? 'text-green-700' : 'text-red-700'}`}
        >
          {m.data.attempt.ok
            ? t('resendOk')
            : t('resendFailed', { error: m.data.attempt.error ?? '' })}
        </span>
      )}
      {m.isError && (
        <span role="alert" className="text-xs text-red-700">
          {errorText(m.error)}
        </span>
      )}
    </span>
  );
}
