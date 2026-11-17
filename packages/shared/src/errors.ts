/** Every error the API returns has one of these codes. The web app translates them. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  INVALID_JSON: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  ALREADY_ASSIGNED: 409,
  INVALID_STATUS: 409,
  COURIER_LIMIT_REACHED: 409,
  SHIFT_CLOSED: 409,
  SHIFT_ALREADY_OPEN: 409,
  SHIFT_HAS_ACTIVE_DELIVERIES: 409,
  ALREADY_PICKED_UP: 409,
  CANCELLED: 409,
  REASSIGNED: 409,
  WRONG_CODE: 422,
  HANDOVER_BLOCKED: 423,
  COD_MISMATCH: 422,
  PHOTO_REQUIRED: 422,
  PHOTO_CONFLICT: 409,
  NOT_YOUR_DELIVERY: 409,
  RETURN_NOT_ALLOWED: 409,
  TOO_EARLY: 409,
  CONFLICT: 409,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
};

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code];
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}
