import { z } from 'zod';
import { FAIL_REASONS, LIMITS, PHOTO_KINDS, ZONES, DELIVERY_STATUSES } from './constants';

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Trimmed text without control characters (blocks newline/NUL injection into logs, headers, CSV). */
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), { message: 'must not contain control characters' });

/** Accepts "+380 (67) 123-45-67" style input and normalises to E.164 "+380671234567". */
export function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;
  let digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  // Local Ukrainian formats: 0671234567 / 380671234567
  if (!cleaned.startsWith('+')) {
    if (/^0\d{9}$/.test(digits)) digits = `38${digits}`;
    else if (!/^380\d{9}$/.test(digits)) return null;
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

export const phoneSchema = z
  .string()
  .trim()
  .max(32)
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (n === null) {
      ctx.addIssue({ code: 'custom', message: 'invalid phone number' });
      return z.NEVER;
    }
    return n;
  });

export const zoneSchema = z.enum(ZONES);
export const statusSchema = z.enum(DELIVERY_STATUSES);
export const uuidSchema = z.uuid();

export const addressSchema = z.strictObject({
  city: text(1, 80),
  street: text(1, 120),
  house: text(1, 20),
  apartment: text(1, 20).optional(),
  note: text(1, 200).optional(),
});
export type Address = z.infer<typeof addressSchema>;

export const weightSchema = z.number().int().min(LIMITS.minWeightG).max(LIMITS.maxWeightG);
export const kopSchema = z.number().int().min(0).max(LIMITS.maxCodKop);

export const quoteInputSchema = z.strictObject({
  zone: zoneSchema,
  weightG: weightSchema,
  codKop: kopSchema.default(0),
});
export type QuoteInput = z.infer<typeof quoteInputSchema>;

export const createDeliverySchema = z.strictObject({
  recipientName: text(1, 100),
  recipientPhone: phoneSchema,
  address: addressSchema,
  zone: zoneSchema,
  weightG: weightSchema,
  codKop: kopSchema.default(0),
});
export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/, 'only letters, digits and _ - : .');

// ───────── courier actions ─────────

const actionBase = {
  clientActionId: uuidSchema,
  deliveryId: uuidSchema,
  /** Device clock at the moment the courier did it. Informational, never trusted for ordering. */
  deviceTime: z.iso.datetime({ offset: true }),
};

export const pickupActionSchema = z.strictObject({ ...actionBase, type: z.literal('pickup') });

export const deliverActionSchema = z.strictObject({
  ...actionBase,
  type: z.literal('deliver'),
  code: z.string().regex(/^\d{6}$/, 'code is 6 digits'),
  codCollectedKop: kopSchema,
  photoId: uuidSchema,
});

export const failActionSchema = z
  .strictObject({
    ...actionBase,
    type: z.literal('fail'),
    reason: z.enum(FAIL_REASONS),
    note: text(1, 200).optional(),
    photoId: uuidSchema,
  })
  .refine((a) => a.reason !== 'other' || !!a.note, {
    path: ['note'],
    message: 'a note is required for reason "other"',
  });

export const courierActionSchema = z.union([
  pickupActionSchema,
  deliverActionSchema,
  failActionSchema,
]);
export type CourierAction = z.infer<typeof courierActionSchema>;

export const courierBatchSchema = z
  .strictObject({
    actions: z.array(courierActionSchema).min(1).max(LIMITS.maxBatchActions),
  })
  .refine((b) => new Set(b.actions.map((a) => a.clientActionId)).size === b.actions.length, {
    path: ['actions'],
    message: 'duplicate clientActionId in batch',
  });
export type CourierBatch = z.infer<typeof courierBatchSchema>;

export const photoKindSchema = z.enum(PHOTO_KINDS);

// ───────── queries ─────────

const page = z.coerce.number().int().min(1).max(100_000).default(1);
const pageSize = z.coerce.number().int().min(1).max(LIMITS.maxPageSize).default(20);

const dateOnly = z.iso.date();

export const deliveryListQuerySchema = z
  .strictObject({
    q: text(1, 64).optional(),
    status: z
      .union([statusSchema, z.array(statusSchema)])
      .transform((v) => (Array.isArray(v) ? v : [v]))
      .optional(),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    page,
    pageSize,
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    path: ['to'],
    message: '"to" must not be before "from"',
  });
export type DeliveryListQuery = z.infer<typeof deliveryListQuerySchema>;

export const reportQuerySchema = z
  .strictObject({ from: dateOnly, to: dateOnly })
  .refine((q) => q.from <= q.to, { path: ['to'], message: '"to" must not be before "from"' })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < LIMITS.maxReportDays, {
    path: ['to'],
    message: `period must not exceed ${LIMITS.maxReportDays} days`,
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const closeShiftSchema = z.strictObject({ handedCashKop: kopSchema });
export const assignSchema = z.strictObject({
  courierId: uuidSchema,
  reassign: z.boolean().default(false),
});

// ───────── notifications (sender webhooks) ─────────

export const webhookSettingsSchema = z.strictObject({
  url: z
    .string()
    .trim()
    .max(2048)
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
        } catch {
          return false;
        }
      },
      { message: 'must be an http(s) URL without credentials' },
    ),
  secret: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[\x21-\x7e]+$/, 'printable characters only, no spaces')
    .optional(),
});
export type WebhookSettings = z.infer<typeof webhookSettingsSchema>;

export const notificationListQuerySchema = z.strictObject({
  status: z.enum(['pending', 'delivered']).optional(),
  deliveryId: uuidSchema.optional(),
  page,
  pageSize,
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
