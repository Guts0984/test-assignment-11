'use client';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Alert, Button } from '@/shared/ui';
import { DeliveryCard } from '@/widgets/delivery-card';
import { CancelButton } from '@/features/cancel-delivery';
import { UnblockButton } from '@/features/unblock-handover';
import { markReturned } from '@/entities/board';
import { deliveryKeys } from '@/entities/delivery';

function ReturnedButton({ id }: { id: string }) {
  const t = useTranslations('card');
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => markReturned(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: deliveryKeys.all }),
  });
  return (
    <Button variant="secondary" disabled={m.isPending} onClick={() => m.mutate()}>
      {t('markReturned')}
    </Button>
  );
}

export function DeliveryDetailPage({
  id,
  viewer,
}: {
  id: string;
  viewer: 'sender' | 'dispatcher';
}) {
  const t = useTranslations('card');
  const created = (useSearchParams() ?? new URLSearchParams()).get('created') === '1';
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6">
      {created && <Alert tone="success">{t('created')}</Alert>}
      <DeliveryCard
        id={id}
        viewer={viewer}
        actions={(c) => (
          <>
            {viewer === 'sender' && <CancelButton id={id} status={c.delivery.status} />}
            {viewer === 'dispatcher' && c.delivery.handoverBlocked && <UnblockButton id={id} />}
            {viewer === 'dispatcher' && c.delivery.status === 'returning' && (
              <ReturnedButton id={id} />
            )}
          </>
        )}
      />
    </main>
  );
}
