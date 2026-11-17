'use client';
import { useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, isApiError, makeApiError } from '@/shared/api';
import { useErrorText } from '@/shared/i18n';
import { useDebounced } from '@/shared/lib';
import { formatMoney, type AppLocale } from '@/shared/lib';
import { Alert, Button, SelectField, TextField } from '@/shared/ui';
import { fetchQuote, deliveryKeys, type DeliveryDto } from '@/entities/delivery';
import {
  EMPTY_FORM,
  FIELD_ORDER,
  SERVER_FIELD,
  parseWeightToGrams,
  toRequest,
  type FieldKey,
  type FormValues,
} from '../model/model';
import { parseMoneyToKop } from '@/shared/lib';

const REQUEST_TIMEOUT_MS = 15_000;

export function CreateDeliveryForm() {
  const t = useTranslations('create');
  const tf = useTranslations('form');
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [formError, setFormError] = useState<ReactNode>(null);
  // one key per form: pressing "Create" again after a lost response returns the same delivery instead of a second one
  const keyRef = useRef(`web-${crypto.randomUUID()}`);

  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: EMPTY_FORM,
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const [zone, weightKg, cod] = watch(['zone', 'weightKg', 'cod']);
  const grams = parseWeightToGrams(weightKg);
  const codKop = cod.trim() === '' ? 0 : parseMoneyToKop(cod);
  const debounced = useDebounced({ zone, grams, codKop }, 250);
  const quotable =
    debounced.grams !== null &&
    debounced.grams >= 1 &&
    debounced.grams <= 30_000 &&
    debounced.codKop !== null &&
    debounced.codKop <= 10_000_000;
  const quote = useQuery({
    queryKey: ['quote', debounced.zone, debounced.grams, debounced.codKop],
    queryFn: () =>
      fetchQuote({ zone: debounced.zone, weightG: debounced.grams!, codKop: debounced.codKop! }),
    enabled: quotable,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const msg = (field: FieldKey, kind: string): string => {
    if (kind === 'weightRange') return tf('weightRange');
    if (kind === 'codRange') return tf('codRange');
    if (kind === 'tooLong') return tf('tooLong');
    if (kind === 'required') return tf('required');
    return field === 'recipientPhone' ? tf('phone') : tf('invalid');
  };

  const create = useMutation({
    mutationFn: (body: unknown) =>
      api<DeliveryDto>('/deliveries', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': keyRef.current },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), // an aborted request surfaces as the NETWORK error
      }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: deliveryKeys.all });
      router.push(`/sender/${d.id}?created=1`);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'VALIDATION_FAILED') {
        let any = false;
        for (const [path, message] of Object.entries(e.fields)) {
          const f = SERVER_FIELD[path];
          if (f) {
            setError(f, { message: tf('invalid') + (message ? '' : '') });
            any = true;
          }
        }
        if (any) return;
      }
      // the response of an earlier attempt was lost, the server did create the delivery: point the user to it
      const id =
        isApiError(e) && e.code === 'IDEMPOTENCY_KEY_REUSED' ? e.details?.deliveryId : null;
      if (typeof id === 'string') {
        setFormError(
          <>
            {t('alreadyCreated')}{' '}
            <Link className="font-medium underline" href={`/sender/${id}`}>
              {t('openCreated')}
            </Link>
          </>,
        );
        return;
      }
      setFormError(errorText(e));
    },
  });

  const submit = handleSubmit((v) => {
    setFormError(null);
    const r = toRequest(v);
    if (!r.ok) {
      for (const i of r.issues) setError(i.field, { message: msg(i.field, i.kind) });
      const first = FIELD_ORDER.find((f) => r.issues.some((i) => i.field === f));
      if (first) document.getElementById(`f-${first}`)?.focus();
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setFormError(errorText(makeApiError({ status: 0, code: 'NETWORK', message: 'offline' })));
      return;
    }
    create.mutate(r.body);
  });

  const err = (f: FieldKey) => errors[f]?.message;

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t('title')}
      className="grid gap-4 md:grid-cols-2"
    >
      {formError && (
        <div className="md:col-span-2">
          <Alert tone={typeof formError === 'string' ? 'error' : 'info'}>{formError}</Alert>
        </div>
      )}
      <fieldset className="grid gap-3 md:col-span-2 md:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold">{t('recipient')}</legend>
        <TextField
          id="f-recipientName"
          label={t('name')}
          autoComplete="off"
          error={err('recipientName')}
          {...register('recipientName')}
        />
        <TextField
          id="f-recipientPhone"
          label={t('phone')}
          type="tel"
          inputMode="tel"
          placeholder="+380 67 123 45 67"
          error={err('recipientPhone')}
          {...register('recipientPhone')}
        />
      </fieldset>
      <fieldset className="grid gap-3 md:col-span-2 md:grid-cols-4">
        <legend className="mb-1 text-sm font-semibold">{t('address')}</legend>
        <TextField id="f-city" label={t('city')} error={err('city')} {...register('city')} />
        <TextField
          id="f-street"
          label={t('street')}
          error={err('street')}
          {...register('street')}
        />
        <TextField id="f-house" label={t('house')} error={err('house')} {...register('house')} />
        <TextField
          id="f-apartment"
          label={t('apartment')}
          error={err('apartment')}
          {...register('apartment')}
        />
        <TextField
          id="f-note"
          label={t('note')}
          className="md:col-span-4"
          error={err('note')}
          {...register('note')}
        />
      </fieldset>
      <fieldset className="grid gap-3 md:col-span-2 md:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">{t('parcel')}</legend>
        <SelectField id="f-zone" label={t('zone')} error={err('zone')} {...register('zone')}>
          {(['A', 'B', 'C'] as const).map((z) => (
            <option key={z} value={z}>
              {t('zoneOption', { zone: z })}
            </option>
          ))}
        </SelectField>
        <TextField
          id="f-weightKg"
          label={t('weight')}
          inputMode="decimal"
          placeholder="1,5"
          error={err('weightKg')}
          {...register('weightKg')}
        />
        <TextField
          id="f-cod"
          label={t('cod')}
          inputMode="decimal"
          placeholder="0"
          hint={t('codHint')}
          error={err('cod')}
          {...register('cod')}
        />
      </fieldset>

      <section
        aria-live="polite"
        aria-label={t('price')}
        className="rounded-md border border-slate-300 bg-slate-50 p-4 md:col-span-2"
      >
        <h2 className="mb-2 text-sm font-semibold">{t('price')}</h2>
        {quote.data && quotable ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="quote">
            <dt>{t('fee')}</dt>
            <dd>{formatMoney(quote.data.feeKop, locale)}</dd>
            <dt>{t('commission')}</dt>
            <dd>{formatMoney(quote.data.codCommissionKop, locale)}</dd>
            <dt className="font-semibold">{t('total')}</dt>
            <dd className="font-semibold" data-testid="quote-total">
              {formatMoney(quote.data.totalKop, locale)}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-slate-600">{t('priceHint')}</p>
        )}
        {quote.isError && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {errorText(quote.error)}
          </p>
        )}
      </section>

      <div className="md:col-span-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t('creating') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
