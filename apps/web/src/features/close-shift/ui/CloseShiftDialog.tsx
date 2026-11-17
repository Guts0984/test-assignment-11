'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, Dialog, Spinner, TextField } from '@/shared/ui';
import { useErrorText } from '@/shared/i18n';
import { formatMoney, kopToInput, parseMoneyToKop, type AppLocale } from '@/shared/lib';
import { closeShift, fetchShift, type BoardCourier, type CloseResult } from '@/entities/board';
import { deliveryKeys } from '@/entities/delivery';

export function CloseShiftDialog({
  courier,
  onClose,
}: {
  courier: BoardCourier | null;
  onClose: () => void;
}) {
  const t = useTranslations('shift');
  const tf = useTranslations('form');
  const locale = useLocale() as AppLocale;
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [handed, setHanded] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);

  const summary = useQuery({
    queryKey: ['shift', courier?.id],
    queryFn: () => fetchShift(courier!.id),
    enabled: !!courier && !result,
  });
  const m = useMutation({
    mutationFn: (kop: number) => closeShift(courier!.id, kop),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: deliveryKeys.board });
      void qc.invalidateQueries({ queryKey: ['report'] });
    },
  });
  const close = () => {
    setHanded('');
    setFieldError(null);
    setResult(null);
    m.reset();
    onClose();
  };

  const submit = () => {
    const kop = parseMoneyToKop(handed);
    if (kop === null) {
      setFieldError(handed.trim() === '' ? tf('required') : tf('invalid'));
      return;
    }
    setFieldError(null);
    m.mutate(kop);
  };

  return (
    <Dialog
      open={!!courier}
      onClose={close}
      title={courier ? t('title', { name: courier.name }) : ''}
    >
      {result ? (
        <div className="flex flex-col gap-3" data-testid="shift-result">
          <dl className="grid grid-cols-[1fr_auto] gap-1 text-sm">
            <dt>{t('expected')}</dt>
            <dd>{formatMoney(result.expectedCashKop, locale)}</dd>
            <dt>{t('handed')}</dt>
            <dd>{formatMoney(result.handedCashKop, locale)}</dd>
            <dt className="font-semibold">{t('discrepancy')}</dt>
            <dd className="font-semibold" data-testid="discrepancy">
              {formatMoney(result.discrepancyKop, locale)}
            </dd>
          </dl>
          <Alert tone={result.discrepancyKop === 0 ? 'success' : 'info'}>
            {result.discrepancyKop === 0 ? t('exact') : t('recorded')}
          </Alert>
          <div className="flex justify-end">
            <Button onClick={close}>{t('done')}</Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3"
          noValidate
        >
          {summary.isLoading && <Spinner label={t('loading')} />}
          {summary.isError && <Alert>{errorText(summary.error)}</Alert>}
          {summary.data && (
            <>
              <p className="text-sm">
                {t('expected')}:{' '}
                <strong data-testid="expected-cash">
                  {formatMoney(summary.data.expectedCashKop, locale)}
                </strong>
              </p>
              {summary.data.activeDeliveries > 0 && (
                <Alert>{t('hasActive', { count: summary.data.activeDeliveries })}</Alert>
              )}
              <TextField
                label={t('handedLabel')}
                inputMode="decimal"
                value={handed}
                onChange={(e) => setHanded(e.target.value)}
                placeholder={kopToInput(summary.data.expectedCashKop)}
                error={fieldError ?? undefined}
              />
            </>
          )}
          {m.isError && <Alert>{errorText(m.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={m.isPending || !summary.data}>
              {t('close')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
