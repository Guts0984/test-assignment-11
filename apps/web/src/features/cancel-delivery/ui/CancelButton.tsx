'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { canCancel, type DeliveryStatus } from '@courier/shared';
import { Alert, Button, Dialog } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { cancelDelivery, deliveryKeys } from '@/entities/delivery';

export function CancelButton({ id, status }: { id: string; status: DeliveryStatus }) {
  const t = useTranslations('card');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const m = useMutation({
    mutationFn: () => cancelDelivery(id),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: deliveryKeys.all });
    },
  });
  if (!canCancel(status)) return null;
  return (
    <>
      <Button
        variant="danger"
        onClick={() => {
          m.reset();
          setOpen(true);
        }}
      >
        {t('cancel')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('cancelTitle')}>
        <p className="text-sm">{t('cancelBody')}</p>
        {m.isError && <Alert>{errorText(m.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t('keep')}
          </Button>
          <Button variant="danger" disabled={m.isPending} onClick={() => m.mutate()}>
            {t('confirmCancel')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
