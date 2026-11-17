import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@courier/db';
import { startOfLocalDay, type ReportQuery } from '@courier/shared';
import { appError } from '../errors';
import {
  ACTIVE,
  addEvent,
  countActive,
  lockCourier,
  lockDelivery,
  notFound,
  openShiftOf,
  toIso,
  type Ctx,
} from './common';
import { dispatcherDto } from './dto';

const d = schema.deliveries;

/**
 * Invariants 3 and 4. Lock order: delivery row, then courier row. Two dispatchers assigning the same delivery
 * queue on the delivery lock; the second then sees `assigned` and is refused. Two assignments to one courier queue
 * on the courier lock, so the 8-delivery limit is checked against an up-to-date count.
 */
export async function assignDelivery(
  ctx: Ctx,
  dispatcherId: string,
  deliveryId: string,
  input: { courierId: string; reassign: boolean },
) {
  return ctx.db.transaction(async (tx) => {
    const row = await lockDelivery(tx, deliveryId);
    if (!row) throw notFound('Delivery');
    const now = ctx.clock.now();

    switch (row.status) {
      case 'created':
        break;
      case 'failed_attempt':
        if (row.nextAttemptAt && row.nextAttemptAt > now) {
          throw appError('TOO_EARLY', 'The next attempt is only allowed from the next day', {
            nextAttemptAt: row.nextAttemptAt.toISOString(),
          });
        }
        break;
      case 'assigned':
        if (!input.reassign || row.courierId === input.courierId) {
          throw appError('ALREADY_ASSIGNED', 'This delivery is already assigned to a courier', {
            courierId: row.courierId,
          });
        }
        break;
      case 'picked_up':
        throw appError('ALREADY_PICKED_UP', 'The courier already picked this delivery up', {
          status: row.status,
        });
      default:
        throw appError('INVALID_STATUS', `A delivery that is ${row.status} cannot be assigned`, {
          status: row.status,
        });
    }

    const courier = await lockCourier(tx, input.courierId);
    if (!courier || !courier.active) throw notFound('Courier');
    const shift = await openShiftOf(tx, input.courierId);
    if (!shift)
      throw appError('SHIFT_CLOSED', "The courier's shift is closed", {
        courierId: input.courierId,
      });
    const active = await countActive(tx, input.courierId, deliveryId);
    if (active >= ctx.env.MAX_ACTIVE_DELIVERIES_PER_COURIER) {
      throw appError('COURIER_LIMIT_REACHED', `The courier already has ${active} deliveries`, {
        active,
        limit: ctx.env.MAX_ACTIVE_DELIVERIES_PER_COURIER,
      });
    }

    const reassigning = row.status === 'assigned';
    const [updated] = await tx
      .update(d)
      .set({
        status: 'assigned',
        courierId: input.courierId,
        assignedAt: now,
        nextAttemptAt: null,
        attemptNo: row.status === 'failed_attempt' ? row.attemptNo + 1 : row.attemptNo,
      })
      .where(eq(d.id, deliveryId))
      .returning();
    await tx
      .update(schema.assignments)
      .set({ endedAt: now, endReason: 'reassigned' })
      .where(
        and(
          eq(schema.assignments.deliveryId, deliveryId),
          sql`${schema.assignments.endedAt} is null`,
        ),
      );
    await tx.insert(schema.assignments).values({
      deliveryId,
      courierId: input.courierId,
      assignedBy: dispatcherId,
      assignedAt: now,
    });
    await addEvent(tx, {
      deliveryId,
      type: reassigning ? 'reassigned' : 'assigned',
      from: row.status,
      to: 'assigned',
      actorId: dispatcherId,
      actorRole: 'dispatcher',
      at: now,
      payload: {
        courierId: input.courierId,
        attemptNo: updated!.attemptNo,
        ...(reassigning ? { previousCourierId: row.courierId } : {}),
      },
    });
    return { delivery: dispatcherDto(updated!) };
  });
}

export async function unblockHandover(ctx: Ctx, dispatcherId: string, deliveryId: string) {
  return ctx.db.transaction(async (tx) => {
    const row = await lockDelivery(tx, deliveryId);
    if (!row) throw notFound('Delivery');
    if (!row.handoverBlocked)
      throw appError('INVALID_STATUS', 'The handover is not blocked', { status: row.status });
    const [updated] = await tx
      .update(d)
      .set({ handoverBlocked: false, wrongCodeStreak: 0 })
      .where(eq(d.id, deliveryId))
      .returning();
    await addEvent(tx, {
      deliveryId,
      type: 'handover_unblocked',
      from: row.status,
      to: row.status,
      actorId: dispatcherId,
      actorRole: 'dispatcher',
      at: ctx.clock.now(),
    });
    return { delivery: dispatcherDto(updated!) };
  });
}

/** returning → returned: the parcel is back with the sender. */
export async function markReturned(ctx: Ctx, dispatcherId: string, deliveryId: string) {
  return ctx.db.transaction(async (tx) => {
    const row = await lockDelivery(tx, deliveryId);
    if (!row) throw notFound('Delivery');
    if (row.status !== 'returning')
      throw appError(
        'RETURN_NOT_ALLOWED',
        `Only a returning delivery can be marked returned (it is ${row.status})`,
        { status: row.status },
      );
    const [updated] = await tx
      .update(d)
      .set({ status: 'returned' })
      .where(eq(d.id, deliveryId))
      .returning();
    await addEvent(tx, {
      deliveryId,
      type: 'returned',
      from: 'returning',
      to: 'returned',
      actorId: dispatcherId,
      actorRole: 'dispatcher',
      at: ctx.clock.now(),
    });
    return { delivery: dispatcherDto(updated!) };
  });
}

// ───────── shifts ─────────

/** Expected cash = what the courier collected on deliveries attributed to this shift. */
async function expectedCash(
  tx: Parameters<Parameters<Ctx['db']['transaction']>[0]>[0],
  shiftId: string,
): Promise<number> {
  const rows = await tx.execute<{ total: string | number | null }>(
    sql`select coalesce(sum(cod_collected_kop), 0) as total from deliveries where delivered_shift_id = ${shiftId}`,
  );
  return Number(rows[0]?.total ?? 0);
}

export async function shiftSummary(ctx: Ctx, courierId: string) {
  return ctx.db.transaction(async (tx) => {
    const shift = await openShiftOf(tx, courierId);
    if (!shift) throw appError('SHIFT_CLOSED', 'The courier has no open shift', { courierId });
    const active = await countActive(tx, courierId);
    return {
      shiftId: shift.id,
      courierId,
      openedAt: shift.openedAt.toISOString(),
      activeDeliveries: active,
      expectedCashKop: await expectedCash(tx, shift.id),
    };
  });
}

/** Invariant 11: expected cash is computed under the courier row lock, the same lock a delivery takes to pick its shift. */
export async function closeShift(
  ctx: Ctx,
  dispatcherId: string,
  courierId: string,
  handedCashKop: number,
) {
  return ctx.db.transaction(async (tx) => {
    const courier = await lockCourier(tx, courierId);
    if (!courier) throw notFound('Courier');
    const shift = await openShiftOf(tx, courierId);
    if (!shift) throw appError('SHIFT_CLOSED', 'The courier has no open shift', { courierId });
    const active = await countActive(tx, courierId);
    if (active > 0) {
      throw appError(
        'SHIFT_HAS_ACTIVE_DELIVERIES',
        `The courier still has ${active} active deliveries`,
        { active },
      );
    }
    const expected = await expectedCash(tx, shift.id);
    const now = ctx.clock.now();
    const [closed] = await tx
      .update(schema.shifts)
      .set({
        closedAt: now,
        closedBy: dispatcherId,
        expectedCashKop: expected,
        handedCashKop,
        discrepancyKop: handedCashKop - expected,
      })
      .where(eq(schema.shifts.id, shift.id))
      .returning();
    return {
      shiftId: closed!.id,
      courierId,
      expectedCashKop: expected,
      handedCashKop,
      discrepancyKop: handedCashKop - expected,
      closedAt: now.toISOString(),
    };
  });
}

// ───────── board and report (aggregates, raw SQL) ─────────

export async function board(ctx: Ctx) {
  const now = ctx.clock.now();
  const limit = ctx.env.MAX_ACTIVE_DELIVERIES_PER_COURIER;
  const [queue, counts, couriers, blocked] = await Promise.all([
    ctx.db.execute<Record<string, unknown>>(sql`
      select * from (
        select id, public_number, zone, status, created_at, next_attempt_at, attempt_no, recipient_name, weight_g,
               row_number() over (partition by zone order by created_at, id) as rn
        from deliveries where status in ('created', 'failed_attempt')
      ) x where rn <= 25 order by zone, created_at`),
    ctx.db.execute<{ zone: string; status: string; n: number }>(sql`
      select zone, status, count(*)::int as n from deliveries where status in ('created', 'failed_attempt') group by zone, status`),
    ctx.db.execute<Record<string, unknown>>(sql`
      select c.user_id as id, p.full_name as name, s.id as shift_id, s.opened_at, count(dl.id)::int as active
      from couriers c join profiles p on p.user_id = c.user_id
      left join shifts s on s.courier_id = c.user_id and s.closed_at is null
      left join deliveries dl on dl.courier_id = c.user_id and dl.status in ('assigned', 'picked_up')
      where c.active group by c.user_id, p.full_name, s.id, s.opened_at order by p.full_name`),
    ctx.db.execute<Record<string, unknown>>(sql`
      select dl.id, dl.public_number, dl.courier_id, p.full_name as courier_name, dl.wrong_code_streak
      from deliveries dl left join profiles p on p.user_id = dl.courier_id where dl.handover_blocked order by dl.updated_at`),
  ]);
  const zones = ['A', 'B', 'C'].map((zone) => ({
    zone,
    waiting: counts.filter((c) => c.zone === zone).reduce((a, c) => a + Number(c.n), 0),
    items: queue
      .filter((q) => q.zone === zone)
      .map((q) => {
        const next = toIso(q.next_attempt_at);
        return {
          id: q.id,
          number: q.public_number,
          status: q.status,
          attemptNo: Number(q.attempt_no),
          recipientName: q.recipient_name,
          weightG: Number(q.weight_g),
          createdAt: toIso(q.created_at),
          nextAttemptAt: next,
          assignable: !next || new Date(next) <= now,
        };
      }),
  }));
  return {
    generatedAt: now.toISOString(),
    zones,
    couriers: couriers.map((c) => ({
      id: c.id,
      name: c.name,
      onShift: c.shift_id !== null,
      shiftId: c.shift_id ?? null,
      openedAt: toIso(c.opened_at),
      active: Number(c.active),
      limit,
    })),
    blocked: blocked.map((b) => ({
      id: b.id,
      number: b.public_number,
      courierId: b.courier_id,
      courierName: b.courier_name,
      wrongCodeStreak: Number(b.wrong_code_streak),
    })),
  };
}

function periodBounds(q: ReportQuery): { from: Date; to: Date } {
  const [fy, fm, fd] = q.from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = q.to.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(ty, tm - 1, td + 1));
  return {
    from: startOfLocalDay(fy, fm, fd),
    to: startOfLocalDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

export async function report(ctx: Ctx, q: ReportQuery) {
  const { from, to } = periodBounds(q);
  const f = from.toISOString();
  const t = to.toISOString();
  const [delivered, failed, discrepancies] = await Promise.all([
    ctx.db.execute<{ n: number; avg_seconds: number | null }>(sql`
      select count(*)::int as n, avg(extract(epoch from delivered_at - assigned_at))::float as avg_seconds
      from deliveries where status = 'delivered' and delivered_at >= ${f}::timestamptz and delivered_at < ${t}::timestamptz`),
    ctx.db.execute<{ reason: string | null; n: number }>(sql`
      select coalesce(payload->>'reason', 'unknown') as reason, count(*)::int as n from delivery_events
      where type = 'failed_attempt' and server_time >= ${f}::timestamptz and server_time < ${t}::timestamptz
      group by 1 order by 2 desc`),
    ctx.db.execute<Record<string, unknown>>(sql`
      select s.id, s.courier_id, p.full_name as courier_name, s.closed_at, s.expected_cash_kop, s.handed_cash_kop, s.discrepancy_kop
      from shifts s join profiles p on p.user_id = s.courier_id
      where s.closed_at >= ${f}::timestamptz and s.closed_at < ${t}::timestamptz and s.discrepancy_kop <> 0
      order by abs(s.discrepancy_kop) desc, s.closed_at desc limit 200`),
  ]);
  const totals = await ctx.db.execute<{
    shifts: number;
    total: string | number | null;
    abs_total: string | number | null;
  }>(sql`
    select count(*)::int as shifts, coalesce(sum(discrepancy_kop), 0) as total, coalesce(sum(abs(discrepancy_kop)), 0) as abs_total
    from shifts where closed_at >= ${f}::timestamptz and closed_at < ${t}::timestamptz and discrepancy_kop <> 0`);
  const avg = delivered[0]?.avg_seconds;
  return {
    period: { from: q.from, to: q.to },
    delivered: {
      count: Number(delivered[0]?.n ?? 0),
      avgAssignToDeliverSeconds: avg === null || avg === undefined ? null : Math.round(Number(avg)),
    },
    failedAttempts: {
      total: failed.reduce((a, r) => a + Number(r.n), 0),
      byReason: failed.map((r) => ({ reason: r.reason, count: Number(r.n) })),
    },
    cashDiscrepancies: {
      shifts: Number(totals[0]?.shifts ?? 0),
      totalKop: Number(totals[0]?.total ?? 0),
      absoluteTotalKop: Number(totals[0]?.abs_total ?? 0),
      items: discrepancies.map((r) => ({
        shiftId: r.id,
        courierId: r.courier_id,
        courierName: r.courier_name,
        closedAt: toIso(r.closed_at),
        expectedKop: Number(r.expected_cash_kop),
        handedKop: Number(r.handed_cash_kop),
        discrepancyKop: Number(r.discrepancy_kop),
      })),
    },
  };
}

export { ACTIVE };
