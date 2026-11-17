'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Button } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { unblock } from '@/entities/board';
import { deliveryKeys } from '@/entities/delivery';

export function UnblockButton({ id }: { id: string }) {
  const t = useTranslations('board');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => unblock(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: deliveryKeys.board });
      void qc.invalidateQueries({ queryKey: deliveryKeys.all });
    },
  });
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" disabled={m.isPending} onClick={() => m.mutate()}>
        {t('unblock')}
      </Button>
      {m.isError && (
        <span role="alert" className="text-xs text-red-700">
          {errorText(m.error)}
        </span>
      )}
    </span>
  );
}
