import type { ErrorCode } from '@courier/shared';

/** Translation key for an API error code (messages live in shared/i18n/messages). */
export const errorKey = (code: string): string => `errors.${code}`;

export type ErrorDetails = {
  active?: number;
  limit?: number;
  nextAttemptAt?: string;
  attemptsLeft?: number;
  expectedKop?: number;
};
export type KnownCode = ErrorCode | 'NETWORK';
