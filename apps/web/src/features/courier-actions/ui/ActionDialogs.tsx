'use client';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { FAIL_REASONS, type CourierAction } from '@courier/shared';
import { Button, Dialog, SelectField, TextField } from '@/shared/ui';
import { kopToInput } from '@/shared/lib';
import { validateDeliver } from '../model/validate';
import { PhotoPicker, type Picked } from './PhotoPicker';

export type Target = { id: string; number: string; amountDueKop: number };
export type Submit = (
  action: CourierAction,
  photo: {
    id: string;
    deliveryId: string;
    kind: 'handover' | 'failed';
    data: ArrayBuffer;
    contentType: string;
  },
) => Promise<void>;

const base = (deliveryId: string) => ({
  clientActionId: crypto.randomUUID(),
  deliveryId,
  deviceTime: new Date().toISOString(),
});

export function DeliverDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: Target | null;
  onClose: () => void;
  onSubmit: Submit;
}) {
  const t = useTranslations('courier');
  const tf = useTranslations('form');
  void useLocale();
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [photo, setPhoto] = useState<Picked | null>(null);
  const [errors, setErrors] = useState<Partial<Record<'code' | 'amount' | 'photo', string>>>({});
  const [busy, setBusy] = useState(false);
  const reset = () => {
    setCode('');
    setAmount('');
    setPhoto(null);
    setErrors({});
    setBusy(false);
  };
  const close = () => {
    reset();
    onClose();
  };
  const msg = (k?: string) =>
    k === 'required'
      ? tf('required')
      : k === 'code'
        ? t('codeInvalid')
        : k
          ? tf('invalid')
          : undefined;

  const submit = async () => {
    if (!target) return;
    const r = validateDeliver(
      { code, amount: amount === '' ? kopToInput(target.amountDueKop) : amount },
      !!photo,
    );
    if (!r.ok) {
      setErrors({
        code: msg(r.errors.code),
        amount: msg(r.errors.amount),
        photo: r.errors.photo ? t('photoRequired') : undefined,
      });
      return;
    }
    setBusy(true);
    const photoId = crypto.randomUUID();
    await onSubmit(
      { type: 'deliver', ...base(target.id), code: r.code, codCollectedKop: r.kop, photoId },
      { id: photoId, deliveryId: target.id, kind: 'handover', ...photo! },
    );
    close();
  };

  return (
    <Dialog
      open={!!target}
      onClose={close}
      title={target ? t('deliverTitle', { number: target.number }) : ''}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
        className="flex flex-col gap-3"
      >
        <TextField
          label={t('code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          error={errors.code}
        />
        <TextField
          label={t('amountReceived')}
          inputMode="decimal"
          value={amount}
          placeholder={target ? kopToInput(target.amountDueKop) : ''}
          onChange={(e) => setAmount(e.target.value)}
          hint={t('amountHint')}
          error={errors.amount}
        />
        <PhotoPicker label={t('handoverPhoto')} error={errors.photo} onPick={setPhoto} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('confirmDeliver')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function FailDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: Target | null;
  onClose: () => void;
  onSubmit: Submit;
}) {
  const t = useTranslations('courier');
  const tr = useTranslations('reason');
  const tf = useTranslations('form');
  const [reason, setReason] = useState<(typeof FAIL_REASONS)[number]>('recipient_absent');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<Picked | null>(null);
  const [errors, setErrors] = useState<{ note?: string; photo?: string }>({});
  const [busy, setBusy] = useState(false);
  const close = () => {
    setReason('recipient_absent');
    setNote('');
    setPhoto(null);
    setErrors({});
    setBusy(false);
    onClose();
  };

  const submit = async () => {
    if (!target) return;
    const e: { note?: string; photo?: string } = {};
    if (reason === 'other' && note.trim() === '') e.note = tf('required');
    if (!photo) e.photo = t('photoRequired');
    setErrors(e);
    if (e.note || e.photo) return;
    setBusy(true);
    const photoId = crypto.randomUUID();
    await onSubmit(
      {
        type: 'fail',
        ...base(target.id),
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
        photoId,
      },
      { id: photoId, deliveryId: target.id, kind: 'failed', ...photo! },
    );
    close();
  };

  return (
    <Dialog
      open={!!target}
      onClose={close}
      title={target ? t('failTitle', { number: target.number }) : ''}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
        className="flex flex-col gap-3"
      >
        <SelectField
          label={t('reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value as (typeof FAIL_REASONS)[number])}
        >
          {FAIL_REASONS.map((r) => (
            <option key={r} value={r}>
              {tr(r)}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('note')}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          error={errors.note}
        />
        <PhotoPicker label={t('failPhoto')} error={errors.photo} onPick={setPhoto} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={busy}>
            {t('confirmFail')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
