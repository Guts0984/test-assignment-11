/**
 * Drizzle mirror of the SQL migrations in /supabase/migrations (the migrations are the source of truth).
 * tests/schema-drift.test.ts compares this file with the live database, so the two cannot silently diverge.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Address } from '@courier/shared';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const kop = (name: string) => bigint(name, { mode: 'number' });

export const userRole = pgEnum('user_role', ['sender', 'dispatcher', 'courier']);
export const zone = pgEnum('zone', ['A', 'B', 'C']);
export const deliveryStatus = pgEnum('delivery_status', [
  'created',
  'assigned',
  'picked_up',
  'delivered',
  'failed_attempt',
  'returning',
  'returned',
  'cancelled',
]);
export const eventType = pgEnum('event_type', [
  'created',
  'assigned',
  'reassigned',
  'released',
  'cancelled',
  'picked_up',
  'delivered',
  'failed_attempt',
  'returning',
  'returned',
  'wrong_code',
  'handover_blocked',
  'handover_unblocked',
]);
export const photoKind = pgEnum('photo_kind', ['handover', 'failed']);
export const actionType = pgEnum('action_type', ['pickup', 'deliver', 'fail']);
export const actionResult = pgEnum('action_result', ['applied', 'rejected']);
export const notificationStatus = pgEnum('notification_status', ['pending', 'delivered']);
export const assignmentEndReason = pgEnum('assignment_end_reason', [
  'reassigned',
  'timeout',
  'cancelled',
  'delivered',
  'delivered_by_other',
  'failed',
]);

export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey(),
  role: userRole('role').notNull(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const senders = pgTable('senders', {
  userId: uuid('user_id').primaryKey(),
  company: text('company').notNull(),
});

export const senderWebhooks = pgTable('sender_webhooks', {
  senderId: uuid('sender_id').primaryKey(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const couriers = pgTable('couriers', {
  userId: uuid('user_id').primaryKey(),
  active: boolean('active').notNull().default(true),
});

export const deliveryNumberCounter = pgTable('delivery_number_counter', {
  id: integer('id').primaryKey(),
  value: bigint('value', { mode: 'number' }).notNull(),
});

export const shifts = pgTable('shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  courierId: uuid('courier_id').notNull(),
  openedAt: ts('opened_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
  closedBy: uuid('closed_by'),
  expectedCashKop: kop('expected_cash_kop'),
  handedCashKop: kop('handed_cash_kop'),
  discrepancyKop: kop('discrepancy_kop'),
});

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Assigned by a BEFORE INSERT trigger; whatever is passed on insert is overwritten. */
    number: bigint('number', { mode: 'number' }).notNull().default(0),
    publicNumber: text('public_number').generatedAlwaysAs(
      sql`'DLV-' || case when number >= 1000000 then number::text else lpad(number::text, 6, '0') end`,
    ),
    senderId: uuid('sender_id').notNull(),
    status: deliveryStatus('status').notNull().default('created'),
    courierId: uuid('courier_id'),
    recipientName: text('recipient_name').notNull(),
    recipientPhone: text('recipient_phone').notNull(),
    address: jsonb('address').$type<Address>().notNull(),
    zone: zone('zone').notNull(),
    weightG: integer('weight_g').notNull(),
    codKop: kop('cod_kop').notNull().default(0),
    feeKop: kop('fee_kop').notNull(),
    codCommissionKop: kop('cod_commission_kop').notNull(),
    totalKop: kop('total_kop').notNull(),
    attemptNo: smallint('attempt_no').notNull().default(1),
    nextAttemptAt: ts('next_attempt_at'),
    assignedAt: ts('assigned_at'),
    pickedUpAt: ts('picked_up_at'),
    deliveredAt: ts('delivered_at'),
    codCollectedKop: kop('cod_collected_kop'),
    deliveredShiftId: uuid('delivered_shift_id'),
    handoverBlocked: boolean('handover_blocked').notNull().default(false),
    wrongCodeStreak: smallint('wrong_code_streak').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('deliveries_sender_created').on(t.senderId, t.createdAt, t.id)],
);

export const deliverySecrets = pgTable('delivery_secrets', {
  deliveryId: uuid('delivery_id').primaryKey(),
  recipientCode: text('recipient_code').notNull(),
  trackingToken: text('tracking_token').notNull(),
  trackingChannel: text('tracking_channel').notNull(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    senderId: uuid('sender_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    deliveryId: uuid('delivery_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.senderId, t.key] })],
);

export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').notNull(),
  courierId: uuid('courier_id').notNull(),
  assignedBy: uuid('assigned_by'),
  assignedAt: ts('assigned_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
  endReason: assignmentEndReason('end_reason'),
});

export const deliveryEvents = pgTable('delivery_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  deliveryId: uuid('delivery_id').notNull(),
  type: eventType('type').notNull(),
  fromStatus: deliveryStatus('from_status'),
  toStatus: deliveryStatus('to_status'),
  actorId: uuid('actor_id'),
  actorRole: text('actor_role').notNull(),
  deviceTime: ts('device_time'),
  serverTime: ts('server_time').notNull().defaultNow(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
});

export const courierActions = pgTable(
  'courier_actions',
  {
    courierId: uuid('courier_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    deliveryId: uuid('delivery_id').notNull(),
    type: actionType('type').notNull(),
    deviceTime: ts('device_time').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    result: actionResult('result'),
    rejectCode: text('reject_code'),
    rejectMessage: text('reject_message'),
    response: jsonb('response').$type<Record<string, unknown>>(),
  },
  (t) => [primaryKey({ columns: [t.courierId, t.clientActionId] })],
);

export const photos = pgTable('photos', {
  id: uuid('id').primaryKey(),
  deliveryId: uuid('delivery_id').notNull(),
  courierId: uuid('courier_id').notNull(),
  kind: photoKind('kind').notNull(),
  storagePath: text('storage_path').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  contentType: text('content_type').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const cashAdjustments = pgTable('cash_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  shiftId: uuid('shift_id').notNull(),
  deliveryId: uuid('delivery_id').notNull(),
  amountKop: kop('amount_kop').notNull(),
  reason: text('reason').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').notNull(),
  senderId: uuid('sender_id').notNull(),
  seq: integer('seq').notNull(),
  eventType: eventType('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: notificationStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
  deliveredAt: ts('delivered_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const notificationAttempts = pgTable('notification_attempts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  notificationId: uuid('notification_id').notNull(),
  attemptedAt: ts('attempted_at').notNull().defaultNow(),
  httpStatus: integer('http_status'),
  error: text('error'),
  durationMs: integer('duration_ms'),
  manual: boolean('manual').notNull().default(false),
});
