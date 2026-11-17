import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { schema } from '@courier/db';
import {
  LIMITS,
  canForceHandover,
  courierActionSchema,
  deliverActionSchema,
  failActionSchema,
  pickupActionSchema,
  nextAttemptAt,
  uuidSchema,
  type CourierAction,
} from '@courier/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { appError } from '../errors';
import { safeEqual, sha256Hex } from '../secrets';
import { sniffImage } from '../image';
import {
  addEvent,
  countActive,
  lockCourier,
  lockDelivery,
  notFound,
  openShiftOf,
  toIso,
  type Ctx,
  type DeliveryRow,
  type Tx,
} from './common';
import { courierDto } from './dto';
import type { ErrorCode } from '@courier/shared';

const d = schema.deliveries;

// ───────── shifts and the day list ─────────

export async function openShift(ctx: Ctx, courierId: string) {
  return ctx.db.transaction(async (tx) => {
    await lockCourier(tx, courierId);
    const existing = await openShiftOf(tx, courierId);
    if (existing)
      throw appError('SHIFT_ALREADY_OPEN', 'Your shift is already open', { shiftId: existing.id });
    const [s] = await tx
      .insert(schema.shifts)
      .values({ courierId, openedAt: ctx.clock.now() })
      .returning();
    return { shiftId: s!.id, openedAt: s!.openedAt.toISOString() };
  });
}

export async function courierToday(ctx: Ctx, courierId: string) {
  const since = new Date(ctx.clock.now().getTime() - 24 * 3600 * 1000);
  const [shift, rows, removed] = await Promise.all([
    ctx.db
      .select()
      .from(schema.shifts)
      .where(and(eq(schema.shifts.courierId, courierId), sql`${schema.shifts.closedAt} is null`)),
    ctx.db
      .select()
      .from(d)
      .where(and(eq(d.courierId, courierId), inArray(d.status, ['assigned', 'picked_up'])))
      .orderBy(sql`${d.assignedAt} asc nulls last`, d.id),
    // How a courier learns that a delivery was taken away (reassigned, timed out, cancelled, delivered by someone else).
    ctx.db
      .select({ a: schema.assignments, number: d.publicNumber })
      .from(schema.assignments)
      .innerJoin(d, eq(d.id, schema.assignments.deliveryId))
      .where(
        and(
          eq(schema.assignments.courierId, courierId),
          gt(schema.assignments.endedAt, since),
          inArray(schema.assignments.endReason, [
            'reassigned',
            'timeout',
            'cancelled',
            'delivered_by_other',
          ]),
        ),
      )
      .orderBy(desc(schema.assignments.endedAt))
      .limit(50),
  ]);
  return {
    shift: shift[0] ? { id: shift[0].id, openedAt: shift[0].openedAt.toISOString() } : null,
    limit: LIMITS.maxActivePerCourier,
    deliveries: rows.map(courierDto),
    removed: removed.map((r) => ({
      deliveryId: r.a.deliveryId,
      number: r.number,
      reason: r.a.endReason,
      endedAt: toIso(r.a.endedAt),
    })),
  };
}

export async function rejectedActions(ctx: Ctx, courierId: string) {
  const rows = await ctx.db
    .select({ a: schema.courierActions, number: d.publicNumber })
    .from(schema.courierActions)
    .innerJoin(d, eq(d.id, schema.courierActions.deliveryId))
    .where(
      and(
        eq(schema.courierActions.courierId, courierId),
        eq(schema.courierActions.result, 'rejected'),
      ),
    )
    .orderBy(desc(schema.courierActions.receivedAt))
    .limit(100);
  return {
    items: rows.map((r) => ({
      clientActionId: r.a.clientActionId,
      deliveryId: r.a.deliveryId,
      number: r.number,
      type: r.a.type,
      code: r.a.rejectCode,
      message: r.a.rejectMessage,
      deviceTime: r.a.deviceTime.toISOString(),
      receivedAt: r.a.receivedAt.toISOString(),
    })),
  };
}

// ───────── actions ─────────

export type ActionOutcome =
  | {
      clientActionId: string;
      result: 'applied';
      deliveryId: string;
      status: DeliveryRow['status'];
      noop?: boolean;
      duplicate?: boolean;
    }
  | {
      clientActionId: string;
      result: 'rejected';
      deliveryId: string;
      code: ErrorCode;
      message: string;
      details?: Record<string, unknown>;
      duplicate?: boolean;
    };

type Handler = (
  tx: Tx,
  ctx: Ctx,
  courierId: string,
  a: CourierAction,
  now: Date,
) => Promise<ActionOutcome>;

const applied = (a: CourierAction, status: DeliveryRow['status'], noop = false): ActionOutcome => ({
  clientActionId: a.clientActionId,
  result: 'applied',
  deliveryId: a.deliveryId,
  status,
  ...(noop ? { noop: true } : {}),
});
const rejected = (
  a: CourierAction,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ActionOutcome => ({
  clientActionId: a.clientActionId,
  result: 'rejected',
  deliveryId: a.deliveryId,
  code,
  message,
  ...(details ? { details } : {}),
});

async function hasAssignment(
  tx: Tx,
  deliveryId: string,
  courierId: string,
): Promise<{ assignedAt: Date; endReason: string | null } | undefined> {
  const [r] = await tx
    .select({ assignedAt: schema.assignments.assignedAt, endReason: schema.assignments.endReason })
    .from(schema.assignments)
    .where(
      and(
        eq(schema.assignments.deliveryId, deliveryId),
        eq(schema.assignments.courierId, courierId),
      ),
    )
    .orderBy(desc(schema.assignments.assignedAt))
    .limit(1);
  return r;
}

async function photoOk(
  tx: Tx,
  photoId: string,
  deliveryId: string,
  courierId: string,
  kind: 'handover' | 'failed',
): Promise<boolean> {
  const [p] = await tx
    .select({ id: schema.photos.id })
    .from(schema.photos)
    .where(
      and(
        eq(schema.photos.id, photoId),
        eq(schema.photos.deliveryId, deliveryId),
        eq(schema.photos.courierId, courierId),
        eq(schema.photos.kind, kind),
      ),
    );
  return !!p;
}

const pickup: Handler = async (tx, ctx, courierId, a, now) => {
  const row = await lockDelivery(tx, a.deliveryId);
  if (!row) return rejected(a, 'NOT_FOUND', 'Delivery not found');
  const mine = row.courierId === courierId;
  if (row.status === 'assigned' && mine) {
    await tx.update(d).set({ status: 'picked_up', pickedUpAt: now }).where(eq(d.id, row.id));
    await addEvent(tx, {
      deliveryId: row.id,
      type: 'picked_up',
      from: 'assigned',
      to: 'picked_up',
      actorId: courierId,
      actorRole: 'courier',
      deviceTime: new Date(a.deviceTime),
      at: now,
      payload: { attemptNo: row.attemptNo },
    });
    return applied(a, 'picked_up');
  }
  if (row.status === 'picked_up' && mine) return applied(a, 'picked_up', true);
  if (row.status === 'cancelled')
    return rejected(a, 'CANCELLED', 'The sender cancelled this delivery');
  if ((row.status === 'assigned' || row.status === 'picked_up') && !mine) {
    return rejected(a, 'REASSIGNED', 'This delivery was given to another courier');
  }
  if (row.status === 'created') {
    // Released by the 45-minute job and not taken by anyone else: the courier may still take it back.
    const prev = await hasAssignment(tx, row.id, courierId);
    if (!prev) return rejected(a, 'NOT_YOUR_DELIVERY', 'This delivery was never assigned to you');
    await lockCourier(tx, courierId);
    if (!(await openShiftOf(tx, courierId)))
      return rejected(a, 'SHIFT_CLOSED', 'Your shift is closed');
    const active = await countActive(tx, courierId, row.id);
    if (active >= LIMITS.maxActivePerCourier) {
      return rejected(
        a,
        'COURIER_LIMIT_REACHED',
        'You already carry the maximum number of deliveries',
        { active },
      );
    }
    await tx
      .update(d)
      .set({ status: 'assigned', courierId, assignedAt: now })
      .where(eq(d.id, row.id));
    await tx.insert(schema.assignments).values({ deliveryId: row.id, courierId, assignedAt: now });
    await addEvent(tx, {
      deliveryId: row.id,
      type: 'assigned',
      from: 'created',
      to: 'assigned',
      actorId: courierId,
      actorRole: 'courier',
      at: now,
      payload: { courierId, via: 'offline_pickup' },
    });
    await tx.update(d).set({ status: 'picked_up', pickedUpAt: now }).where(eq(d.id, row.id));
    await addEvent(tx, {
      deliveryId: row.id,
      type: 'picked_up',
      from: 'assigned',
      to: 'picked_up',
      actorId: courierId,
      actorRole: 'courier',
      deviceTime: new Date(a.deviceTime),
      at: now,
      payload: { attemptNo: row.attemptNo },
    });
    return applied(a, 'picked_up');
  }
  return rejected(a, 'INVALID_STATUS', `This delivery is ${row.status}`, { status: row.status });
};

/** Chooses the shift a handover is accounted to. Takes the courier row lock, which `closeShift` also takes. */
async function shiftForHandover(tx: Tx, courierId: string) {
  await lockCourier(tx, courierId);
  const open = await openShiftOf(tx, courierId);
  if (open) return { shiftId: open.id, closed: false };
  const [last] = await tx
    .select()
    .from(schema.shifts)
    .where(eq(schema.shifts.courierId, courierId))
    .orderBy(desc(schema.shifts.openedAt))
    .limit(1);
  return last ? { shiftId: last.id, closed: true } : { shiftId: null, closed: false };
}

const deliver: Handler = async (tx, ctx, courierId, a, now) => {
  if (a.type !== 'deliver') throw new Error('unreachable');
  const row = await lockDelivery(tx, a.deliveryId);
  if (!row) return rejected(a, 'NOT_FOUND', 'Delivery not found');
  const prev = await hasAssignment(tx, row.id, courierId);
  if (!prev) return rejected(a, 'NOT_YOUR_DELIVERY', 'This delivery was never assigned to you');

  if (row.status === 'delivered') {
    return row.courierId === courierId
      ? applied(a, 'delivered', true)
      : rejected(a, 'INVALID_STATUS', 'This delivery was already delivered', {
          status: row.status,
        });
  }
  if (row.status === 'cancelled')
    return rejected(a, 'CANCELLED', 'The sender cancelled this delivery');
  if (!canForceHandover(row.status))
    return rejected(a, 'INVALID_STATUS', `This delivery is ${row.status}`, { status: row.status });
  // Invariant 6: once blocked, nothing is compared any more.
  if (row.handoverBlocked)
    return rejected(
      a,
      'HANDOVER_BLOCKED',
      'The handover is blocked. Ask the dispatcher to unblock it',
    );

  const [secret] = await tx
    .select()
    .from(schema.deliverySecrets)
    .where(eq(schema.deliverySecrets.deliveryId, row.id));
  if (!secret || !safeEqual(a.code, secret.recipientCode)) {
    const streak = row.wrongCodeStreak + 1;
    const blocked = streak >= LIMITS.maxWrongCodes;
    await tx
      .update(d)
      .set({ wrongCodeStreak: streak, handoverBlocked: blocked })
      .where(eq(d.id, row.id));
    await addEvent(tx, {
      deliveryId: row.id,
      type: 'wrong_code',
      from: row.status,
      to: row.status,
      actorId: courierId,
      actorRole: 'courier',
      deviceTime: new Date(a.deviceTime),
      at: now,
      payload: { streak },
    });
    if (blocked)
      await addEvent(tx, {
        deliveryId: row.id,
        type: 'handover_blocked',
        from: row.status,
        to: row.status,
        actorId: null,
        actorRole: 'system',
        at: now,
        payload: { streak },
      });
    return rejected(
      a,
      'WRONG_CODE',
      blocked ? 'Wrong code. The handover is now blocked' : 'Wrong code',
      {
        attemptsLeft: Math.max(0, LIMITS.maxWrongCodes - streak),
        blocked,
      },
    );
  }
  if (a.codCollectedKop !== row.codKop) {
    return rejected(a, 'COD_MISMATCH', 'The collected amount must equal the amount due', {
      expectedKop: row.codKop,
    });
  }
  if (!(await photoOk(tx, a.photoId, row.id, courierId, 'handover'))) {
    return rejected(a, 'PHOTO_REQUIRED', 'The handover photo was not uploaded for this delivery');
  }

  const shift = await shiftForHandover(tx, courierId);
  const viaOffline = row.status !== 'picked_up' || row.courierId !== courierId;
  await tx
    .update(d)
    .set({
      status: 'delivered',
      courierId,
      deliveredAt: now,
      codCollectedKop: a.codCollectedKop,
      deliveredShiftId: shift.shiftId,
      wrongCodeStreak: 0,
      handoverBlocked: false,
      nextAttemptAt: null,
      assignedAt: row.assignedAt ?? prev.assignedAt,
      pickedUpAt: row.pickedUpAt ?? now,
    })
    .where(eq(d.id, row.id));
  // Whoever held the delivery loses it ("delivered_by_other"); the delivering courier's own row closes as "delivered".
  await tx.execute(sql`
    update assignments set ended_at = ${now.toISOString()}::timestamptz,
      end_reason = (case when courier_id = ${courierId} then 'delivered' else 'delivered_by_other' end)::assignment_end_reason
    where delivery_id = ${row.id} and ended_at is null`);
  if (shift.closed && shift.shiftId && a.codCollectedKop > 0) {
    await tx.insert(schema.cashAdjustments).values({
      shiftId: shift.shiftId,
      deliveryId: row.id,
      amountKop: a.codCollectedKop,
      reason: 'handover synced after the shift was closed',
    });
  }
  await addEvent(tx, {
    deliveryId: row.id,
    type: 'delivered',
    from: row.status,
    to: 'delivered',
    actorId: courierId,
    actorRole: 'courier',
    deviceTime: new Date(a.deviceTime),
    at: now,
    payload: {
      attemptNo: row.attemptNo,
      photoId: a.photoId,
      viaOffline,
      ...(row.courierId && row.courierId !== courierId ? { previousCourierId: row.courierId } : {}),
    },
  });
  return applied(a, 'delivered');
};

const fail: Handler = async (tx, ctx, courierId, a, now) => {
  if (a.type !== 'fail') throw new Error('unreachable');
  const row = await lockDelivery(tx, a.deliveryId);
  if (!row) return rejected(a, 'NOT_FOUND', 'Delivery not found');
  if (row.status === 'cancelled')
    return rejected(a, 'CANCELLED', 'The sender cancelled this delivery');
  if (row.courierId !== courierId || row.status !== 'picked_up') {
    if ((row.status === 'assigned' || row.status === 'picked_up') && row.courierId !== courierId) {
      return rejected(a, 'REASSIGNED', 'This delivery was given to another courier');
    }
    if (!(await hasAssignment(tx, row.id, courierId)))
      return rejected(a, 'NOT_YOUR_DELIVERY', 'This delivery was never assigned to you');
    return rejected(a, 'INVALID_STATUS', `This delivery is ${row.status}`, { status: row.status });
  }
  if (!(await photoOk(tx, a.photoId, row.id, courierId, 'failed'))) {
    return rejected(a, 'PHOTO_REQUIRED', 'The photo of the door or entrance was not uploaded');
  }
  const last = row.attemptNo >= LIMITS.maxAttempts;
  await tx
    .update(d)
    .set({
      status: 'failed_attempt',
      courierId: null,
      assignedAt: null,
      pickedUpAt: null,
      nextAttemptAt: last ? null : nextAttemptAt(now, ctx.env.BUSINESS_TIMEZONE),
    })
    .where(eq(d.id, row.id));
  await tx
    .update(schema.assignments)
    .set({ endedAt: now, endReason: 'failed' })
    .where(
      and(eq(schema.assignments.deliveryId, row.id), sql`${schema.assignments.endedAt} is null`),
    );
  await addEvent(tx, {
    deliveryId: row.id,
    type: 'failed_attempt',
    from: 'picked_up',
    to: 'failed_attempt',
    actorId: courierId,
    actorRole: 'courier',
    deviceTime: new Date(a.deviceTime),
    at: now,
    payload: {
      reason: a.reason,
      note: a.note ?? null,
      attemptNo: row.attemptNo,
      photoId: a.photoId,
    },
  });
  if (last) {
    // after the 3rd failed attempt: returning, same transaction, so the sender gets both notifications in order
    await tx.update(d).set({ status: 'returning', nextAttemptAt: null }).where(eq(d.id, row.id));
    await addEvent(tx, {
      deliveryId: row.id,
      type: 'returning',
      from: 'failed_attempt',
      to: 'returning',
      actorId: null,
      actorRole: 'system',
      at: now,
      payload: { attemptNo: row.attemptNo },
    });
    return applied(a, 'returning');
  }
  return applied(a, 'failed_attempt');
};

const HANDLERS: Record<CourierAction['type'], Handler> = { pickup, deliver, fail };

const DB_REJECTIONS: Record<string, [ErrorCode, string]> = {
  DL001: ['INVALID_STATUS', 'This delivery cannot change status like that'],
  DL002: ['COURIER_LIMIT_REACHED', 'You already carry the maximum number of deliveries'],
  DL003: ['SHIFT_CLOSED', 'Your shift is closed'],
  '23514': ['CONFLICT', 'The action conflicts with the current delivery state'],
};
const pgCode = (e: unknown): string | undefined => {
  for (
    let cur: unknown = e, i = 0;
    i < 4 && cur && typeof cur === 'object';
    i++, cur = (cur as { cause?: unknown }).cause
  ) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) return c;
  }
  return undefined;
};

/**
 * Invariants 7, 8, 9. The action row is inserted first with ON CONFLICT DO NOTHING: a retry (even a parallel one)
 * waits for the first transaction, then finds the stored outcome and returns it without touching anything.
 * Every outcome, including rejections with their reason, is stored in `courier_actions`.
 */
export async function processAction(
  ctx: Ctx,
  courierId: string,
  a: CourierAction,
): Promise<ActionOutcome> {
  return ctx.db.transaction(async (tx) => {
    // Lock order is always: delivery, then courier. It must come BEFORE the INSERT below: that INSERT takes shared
    // row locks (foreign keys) which, if an exclusive lock is requested afterwards, deadlock concurrent writers.
    const row = await lockDelivery(tx, a.deliveryId);
    if (!row) return rejected(a, 'NOT_FOUND', 'Delivery not found');
    await lockCourier(tx, courierId);

    const inserted = await tx
      .insert(schema.courierActions)
      .values({
        courierId,
        clientActionId: a.clientActionId,
        deliveryId: a.deliveryId,
        type: a.type,
        deviceTime: new Date(a.deviceTime),
      })
      .onConflictDoNothing()
      .returning({ id: schema.courierActions.clientActionId });
    if (inserted.length === 0) {
      const [stored] = await tx
        .select()
        .from(schema.courierActions)
        .where(
          and(
            eq(schema.courierActions.courierId, courierId),
            eq(schema.courierActions.clientActionId, a.clientActionId),
          ),
        );
      const response = stored?.response as ActionOutcome | null | undefined;
      if (response) return { ...response, duplicate: true } as ActionOutcome;
      return rejected(a, 'CONFLICT', 'This action id was already used');
    }
    const now = ctx.clock.now();
    let outcome: ActionOutcome;
    try {
      // a savepoint: if the database refuses something midway, only the business change is undone
      outcome = await tx.transaction((sp) => HANDLERS[a.type](sp, ctx, courierId, a, now));
    } catch (e) {
      const mapped = DB_REJECTIONS[pgCode(e) ?? ''];
      if (!mapped) throw e;
      outcome = rejected(a, mapped[0], mapped[1]);
    }
    await tx
      .update(schema.courierActions)
      .set({
        result: outcome.result,
        rejectCode: outcome.result === 'rejected' ? outcome.code : null,
        rejectMessage: outcome.result === 'rejected' ? outcome.message : null,
        response: outcome as unknown as Record<string, unknown>,
      })
      .where(
        and(
          eq(schema.courierActions.courierId, courierId),
          eq(schema.courierActions.clientActionId, a.clientActionId),
        ),
      );
    return outcome;
  });
}

export type InvalidActionOutcome = {
  clientActionId: string | null;
  index: number;
  result: 'rejected';
  code: 'VALIDATION_FAILED';
  message: string;
  details: { fields: Record<string, string> };
};

/**
 * Every action is validated on its own, then processed in the order the device recorded them ("pick up" must be applied
 * before "deliver"). An invalid action gets its own rejection; the others in the batch are unaffected.
 */
export async function processBatch(ctx: Ctx, courierId: string, raw: unknown[]) {
  const results: (ActionOutcome | InvalidActionOutcome)[] = [];
  for (const [index, item] of raw.entries()) {
    // validate against the schema of the declared type, so errors name the exact field (not an opaque union failure)
    const type = (item as { type?: unknown } | null)?.type;
    const schema =
      type === 'pickup'
        ? pickupActionSchema
        : type === 'deliver'
          ? deliverActionSchema
          : type === 'fail'
            ? failActionSchema
            : courierActionSchema;
    const parsed = schema.safeParse(item);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const i of parsed.error.issues)
        fields[i.path.map(String).join('.') || 'action'] ??= i.message;
      const id = (item as { clientActionId?: unknown } | null)?.clientActionId;
      results.push({
        clientActionId: typeof id === 'string' && uuidSchema.safeParse(id).success ? id : null,
        index,
        result: 'rejected',
        code: 'VALIDATION_FAILED',
        message: 'This action is not valid',
        details: { fields },
      });
      continue;
    }
    results.push(await processAction(ctx, courierId, parsed.data as CourierAction));
  }
  return { results };
}

// ───────── photos ─────────

/**
 * Invariant 14. The device chooses the photo id. Re-sending the same photo never creates a second file:
 * same id + same bytes → 200 (duplicate); same id + different bytes → 409.
 */
export async function uploadPhoto(
  ctx: Ctx,
  storage: SupabaseClient,
  courierId: string,
  photoId: string,
  deliveryId: string,
  kind: 'handover' | 'failed',
  bytes: Buffer,
) {
  if (bytes.length === 0)
    throw appError('VALIDATION_FAILED', 'Empty body', { fields: { body: 'the image is empty' } });
  if (bytes.length > ctx.env.PHOTO_MAX_BYTES)
    throw appError('PAYLOAD_TOO_LARGE', 'Photo is too large');
  const type = sniffImage(bytes);
  if (!type)
    throw appError('UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG and WebP images are accepted');
  const hash = sha256Hex(bytes);

  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`photo:${photoId}`}, 0))`);
    const [existing] = await tx.select().from(schema.photos).where(eq(schema.photos.id, photoId));
    if (existing) {
      if (
        existing.courierId !== courierId ||
        existing.deliveryId !== deliveryId ||
        existing.sha256 !== hash ||
        existing.kind !== kind
      ) {
        throw appError('PHOTO_CONFLICT', 'A different photo was already stored under this id');
      }
      return { photoId, duplicate: true, sizeBytes: existing.sizeBytes };
    }
    // Only a courier who was assigned this delivery may attach photos to it.
    if (!(await hasAssignment(tx, deliveryId, courierId))) throw notFound('Delivery');
    const path = `${deliveryId}/${photoId}.${type.ext}`;
    const up = await storage.storage
      .from(ctx.env.PHOTO_BUCKET)
      .upload(path, bytes, { contentType: type.contentType, upsert: true });
    if (up.error) throw appError('INTERNAL', 'Could not store the photo');
    await tx.insert(schema.photos).values({
      id: photoId,
      deliveryId,
      courierId,
      kind,
      storagePath: path,
      sha256: hash,
      sizeBytes: bytes.length,
      contentType: type.contentType,
    });
    return { photoId, duplicate: false, sizeBytes: bytes.length };
  });
}
