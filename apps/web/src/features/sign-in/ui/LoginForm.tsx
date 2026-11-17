'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Role } from '@courier/shared';
import { getSupabase } from '@/shared/api';
import { Alert, Button, TextField } from '@/shared/ui';
import { roleHome } from '@/entities/session';

const schema = z.object({
  email: z.string().trim().min(1, 'required').email('email'),
  password: z.string().min(1, 'required'),
});
type Values = z.infer<typeof schema>;

export function LoginForm() {
  const t = useTranslations('login');
  const tf = useTranslations('form');
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const submit = handleSubmit(async (v) => {
    setFormError(null);
    const { data, error } = await getSupabase().auth.signInWithPassword({
      email: v.email,
      password: v.password,
    });
    if (error || !data.user) {
      setFormError(error?.status === 429 ? t('tooMany') : t('invalid'));
      return;
    }
    const role = (data.user.app_metadata?.role as Role | undefined) ?? null;
    router.replace(roleHome(role));
    router.refresh();
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label={t('title')}>
      {formError && <Alert>{formError}</Alert>}
      <TextField
        label={t('email')}
        type="email"
        autoComplete="username"
        error={errors.email && tf(errors.email.message === 'email' ? 'email' : 'required')}
        {...register('email')}
      />
      <TextField
        label={t('password')}
        type="password"
        autoComplete="current-password"
        error={errors.password && tf('required')}
        {...register('password')}
      />
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? t('signingIn') : t('submit')}
      </Button>
    </form>
  );
}
