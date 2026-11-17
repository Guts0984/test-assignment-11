'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { webhookSettingsSchema } from '@courier/shared';
import { Alert, Button, Spinner, TextField } from '@/shared/ui';
import { isApiError } from '@/shared/api';
import { useErrorText } from '@/shared/i18n';
import { deliveryKeys } from '@/entities/delivery';
import { fetchWebhook, saveWebhook } from '@/entities/notification';

type Values = { url: string; secret: string };

export function WebhookForm() {
  const t = useTranslations('settings');
  const tf = useTranslations('form');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const hook = useQuery({ queryKey: deliveryKeys.webhook, queryFn: fetchWebhook });
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<Values>({ defaultValues: { url: '', secret: '' } });
  useEffect(() => {
    if (hook.data) reset({ url: hook.data.url ?? '', secret: hook.data.secret ?? '' });
  }, [hook.data, reset]);

  const save = useMutation({
    mutationFn: (v: Values) =>
      saveWebhook({ url: v.url.trim(), ...(v.secret ? { secret: v.secret } : {}) }),
    onSuccess: () => {
      setFormError(null);
      void qc.invalidateQueries({ queryKey: deliveryKeys.webhook });
    },
    onError: (e) => {
      if (isApiError(e) && e.fields.url) setError('url', { message: e.fields.url });
      else if (isApiError(e) && e.fields.secret) setError('secret', { message: tf('invalid') });
      else setFormError(errorText(e));
    },
  });

  const submit = handleSubmit((v) => {
    setFormError(null);
    const parsed = webhookSettingsSchema.safeParse({
      url: v.url,
      ...(v.secret ? { secret: v.secret } : {}),
    });
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        setError(i.path[0] === 'secret' ? 'secret' : 'url', {
          message: i.path[0] === 'secret' ? t('secretInvalid') : tf('url'),
        });
      return;
    }
    save.mutate(v);
  });

  if (hook.isLoading) return <Spinner label={t('loading')} />;
  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex max-w-xl flex-col gap-4"
      aria-label={t('title')}
    >
      {formError && <Alert>{formError}</Alert>}
      {save.isSuccess && <Alert tone="success">{t('saved')}</Alert>}
      <TextField
        label={t('url')}
        type="url"
        placeholder="https://example.com/hook"
        error={errors.url?.message}
        {...register('url')}
      />
      <TextField
        label={t('secret')}
        hint={t('secretHint')}
        error={errors.secret?.message}
        {...register('secret')}
      />
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}
