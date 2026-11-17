'use client';
import { useTranslations } from 'next-intl';
import { isApiError } from '../api/client';

/** Turns any thrown value into a translated, human sentence. Known codes get specific wording with their details. */
export function useErrorText() {
  const raw = useTranslations('errors');
  const t = raw as unknown as (key: string, values?: Record<string, string | number>) => string;
  return (e: unknown): string => {
    if (!isApiError(e)) return t('INTERNAL');
    const d = (e.details ?? {}) as Record<string, unknown>;
    const known = e.code === 'NETWORK' || e.code in ERROR_KEYS;
    if (!known) return t('INTERNAL');
    return t(e.code, {
      active: Number(d.active ?? 0),
      limit: Number(d.limit ?? 0),
      attemptsLeft: Number(d.attemptsLeft ?? 0),
      date:
        typeof d.nextAttemptAt === 'string' ? new Date(d.nextAttemptAt).toLocaleDateString() : '',
    });
  };
}

const ERROR_KEYS: Record<string, true> = Object.fromEntries(
  [
    'VALIDATION_FAILED',
    'INVALID_JSON',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'PAYLOAD_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE',
    'RATE_LIMITED',
    'IDEMPOTENCY_KEY_REQUIRED',
    'IDEMPOTENCY_KEY_REUSED',
    'ALREADY_ASSIGNED',
    'INVALID_STATUS',
    'COURIER_LIMIT_REACHED',
    'SHIFT_CLOSED',
    'SHIFT_ALREADY_OPEN',
    'SHIFT_HAS_ACTIVE_DELIVERIES',
    'ALREADY_PICKED_UP',
    'CANCELLED',
    'REASSIGNED',
    'WRONG_CODE',
    'HANDOVER_BLOCKED',
    'COD_MISMATCH',
    'PHOTO_REQUIRED',
    'PHOTO_CONFLICT',
    'NOT_YOUR_DELIVERY',
    'RETURN_NOT_ALLOWED',
    'TOO_EARLY',
    'CONFLICT',
    'INTERNAL',
    'NETWORK',
  ].map((k) => [k, true]),
);

/** Same wording as `useErrorText`, for a bare error code (e.g. a rejection stored on the device). */
export function useCodeText() {
  const raw = useTranslations('errors');
  const t = raw as unknown as (key: string, values?: Record<string, string | number>) => string;
  return (code: string, details?: Record<string, unknown>): string =>
    code in ERROR_KEYS
      ? t(code, {
          active: Number(details?.active ?? 0),
          limit: Number(details?.limit ?? 0),
          attemptsLeft: Number(details?.attemptsLeft ?? 0),
          date: '',
        })
      : t('INTERNAL');
}
