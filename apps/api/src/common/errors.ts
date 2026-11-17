import { ERROR_CODES, httpStatusFor, type ApiErrorBody, type ErrorCode } from '@courier/shared';
import { isAppError } from '../domain/errors';

export type HttpError = { status: number; body: ApiErrorBody };

type Pg = { code?: string; message?: string };
const pgOf = (e: unknown): Pg | undefined => {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const c = (cur as Pg).code;
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) return cur as Pg;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
};

const PG_MAP: Record<string, ErrorCode> = {
  DL001: 'INVALID_STATUS',
  DL002: 'COURIER_LIMIT_REACHED',
  DL003: 'SHIFT_CLOSED',
  DL004: 'CONFLICT',
  DL005: 'INVALID_STATUS',
  '23505': 'CONFLICT',
  '23503': 'CONFLICT',
  '23514': 'VALIDATION_FAILED',
  '23502': 'VALIDATION_FAILED',
  '22P02': 'VALIDATION_FAILED',
  '22003': 'VALIDATION_FAILED',
  '22007': 'VALIDATION_FAILED',
  '22008': 'VALIDATION_FAILED',
  '22021': 'VALIDATION_FAILED',
  '22P05': 'VALIDATION_FAILED',
  '40P01': 'CONFLICT', // deadlock: safe to retry
  '40001': 'CONFLICT', // serialization failure
  '55P03': 'CONFLICT', // lock not available
};

const STATUS_FALLBACK: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

const SAFE_MESSAGES: Partial<Record<ErrorCode, string>> = {
  NOT_FOUND: 'Not found',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  RATE_LIMITED: 'Too many requests',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  INVALID_JSON: 'Malformed JSON body',
  VALIDATION_FAILED: 'Validation failed',
  CONFLICT: 'Conflict, please retry',
  INTERNAL: 'Internal server error',
};

/** One mapping for every failure: domain errors, validation, body-parser errors, Postgres errors, bugs. */
export function toHttpError(e: unknown, requestId?: string): HttpError {
  const make = (
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    status?: number,
  ): HttpError => ({
    status: status ?? httpStatusFor(code),
    body: {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    },
  });

  if (isAppError(e)) return make(e.appCode, e.message, e.details);

  const pg = pgOf(e);
  if (pg?.code && PG_MAP[pg.code]) {
    const code = PG_MAP[pg.code]!;
    return make(code, SAFE_MESSAGES[code] ?? 'Request conflicts with current state');
  }

  // body-parser / http-errors / Nest HttpException carry a numeric status
  const status =
    (e as { status?: number; statusCode?: number } | null)?.status ??
    (e as { statusCode?: number } | null)?.statusCode;
  const type = (e as { type?: string } | null)?.type;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Nest re-wraps body-parser failures as a plain BadRequestException, losing `type`: recognise the message
    if (
      status === 400 &&
      /JSON|Unexpected (token|end)|Expected (property|double)/i.test(String((e as Error).message))
    ) {
      return make('INVALID_JSON', SAFE_MESSAGES.INVALID_JSON!);
    }
    if (type === 'entity.too.large')
      return make('PAYLOAD_TOO_LARGE', SAFE_MESSAGES.PAYLOAD_TOO_LARGE!);
    if (
      type === 'entity.parse.failed' ||
      type === 'encoding.unsupported' ||
      type === 'request.size.invalid' ||
      type === 'charset.unsupported'
    ) {
      return make('INVALID_JSON', SAFE_MESSAGES.INVALID_JSON!);
    }
    const code = STATUS_FALLBACK[status] ?? 'VALIDATION_FAILED';
    return make(
      code,
      SAFE_MESSAGES[code] ?? 'Bad request',
      undefined,
      status in STATUS_FALLBACK ? httpStatusFor(code) : status,
    );
  }

  return make('INTERNAL', SAFE_MESSAGES.INTERNAL!);
}

export const isKnownCode = (c: string): c is ErrorCode =>
  Object.prototype.hasOwnProperty.call(ERROR_CODES, c);
