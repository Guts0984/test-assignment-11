import type { ErrorCode } from '@courier/shared';

export type AppError = Error & { appCode: ErrorCode; details?: Record<string, unknown> };

/** Domain code throws these (plain functions, no classes); the HTTP filter turns them into responses. */
export function appError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  const e = new Error(message) as AppError;
  e.name = 'AppError';
  e.appCode = code;
  if (details) e.details = details;
  return e;
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof Error && e.name === 'AppError' && 'appCode' in e;
}
