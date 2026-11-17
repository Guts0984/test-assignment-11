'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Alert, Button, Dialog } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { assign, type BoardCourier } from '@/entities/board';
import { deliveryKeys } from '@/entities/delivery';

type Target = { id: string; number: string; status: string };

export function AssignDialog({
  delivery,
  couriers,
  onClose,
}: {
  delivery: Target | null;
  couriers: BoardCourier[];
  onClose: () => void;
}) {
  const t = useTranslations('assign');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [courierId, setCourierId] = useState('');
  // The status the dialog was OPENED with. A live update (another dispatcher assigned it meanwhile) must not
  // flip us into "reassign": the API's ALREADY_ASSIGNED refusal is the guard and has to reach the user.
  const [opened, setOpened] = useState<{ id: string; status: string } | null>(null);
  if ((delivery?.id ?? null) !== (opened?.id ?? null)) {
    setOpened(delivery ? { id: delivery.id, status: delivery.status } : null);
  }
  const reassign = opened?.status === 'assigned';
  const m = useMutation({
    mutationFn: () => assign(delivery!.id, courierId, reassign),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: deliveryKeys.board });
      void qc.invalidateQueries({ queryKey: deliveryKeys.all });
      close();
    },
  });
  const close = () => {
    setCourierId('');
    m.reset();
    onClose();
  };

  return (
    <Dialog
      open={!!delivery}
      onClose={close}
      title={delivery ? t('title', { number: delivery.number }) : ''}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (courierId) m.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <fieldset className="flex max-h-72 flex-col gap-1 overflow-auto">
          <legend className="mb-1 text-sm font-medium">{t('courier')}</legend>
          {couriers.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center justify-between gap-3 rounded border border-slate-200 px-3 py-2 text-sm has-[:checked]:border-slate-900 has-[:checked]:bg-slate-50"
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="courier"
                  value={c.id}
                  checked={courierId === c.id}
                  onChange={() => {
                    setCourierId(c.id);
                    m.reset();
                  }}
                />
                {c.name}
              </span>
              <span className="text-slate-600">
                {c.active}/{c.limit} · {c.onShift ? t('onShift') : t('offShift')}
              </span>
            </label>
          ))}
        </fieldset>
        {reassign && <Alert tone="info">{t('reassignNote')}</Alert>}
        {m.isError && <Alert>{errorText(m.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {t('close')}
          </Button>
          <Button type="submit" disabled={!courierId || m.isPending}>
            {m.isPending ? t('assigning') : t('submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
