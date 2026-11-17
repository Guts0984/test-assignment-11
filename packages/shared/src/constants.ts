export const ZONES = ['A', 'B', 'C'] as const;
export type Zone = (typeof ZONES)[number];

export const ROLES = ['sender', 'dispatcher', 'courier'] as const;
export type Role = (typeof ROLES)[number];

export const DELIVERY_STATUSES = [
  'created',
  'assigned',
  'picked_up',
  'delivered',
  'failed_attempt',
  'returning',
  'returned',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Statuses that count against the courier's active-delivery limit. */
export const ACTIVE_STATUSES = [
  'assigned',
  'picked_up',
] as const satisfies readonly DeliveryStatus[];

export const FAIL_REASONS = [
  'recipient_absent',
  'wrong_address',
  'recipient_refused',
  'no_access',
  'phone_unreachable',
  'other',
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

export const PHOTO_KINDS = ['handover', 'failed'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export const LIMITS = {
  maxActivePerCourier: 8,
  pickupTimeoutMinutes: 45,
  maxWrongCodes: 5,
  maxAttempts: 3,
  maxBatchActions: 100,
  maxPageSize: 100,
  minWeightG: 1,
  maxWeightG: 30_000,
  maxCodKop: 10_000_000,
  maxReportDays: 366,
  webhookBackoffBaseSeconds: 30,
  webhookBackoffMaxSeconds: 86_400,
} as const;

export const BUSINESS_TIMEZONE = 'Europe/Kyiv';
