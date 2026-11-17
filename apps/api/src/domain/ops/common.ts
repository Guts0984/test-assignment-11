import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@courier/db';
import type { Env } from '../../config/env';
import type { Clock } from '../../common/tokens';
import { appError } from '../errors';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DeliveryRow = typeof schema.deliveries.$inferSelect;

export type Ctx = { db: Db; env: Env; clock: Clock };

export const ACTIVE = ['assigned', 'picked_up'] as const;

/** Row lock on a delivery. Lock order everywhere: delivery first, then courier (no deadlocks). */
export async function lockDelivery(tx: Tx, id: string): Promise<DeliveryRow | undefined> {
  const [row] = await tx
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.id, id))
    .for('update');
  return row;
}

export async function lockCourier(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(schema.couriers)
    .where(eq(schema.couriers.userId, id))
    .for('update');
  return row;
}

export async function countActive(
  tx: Tx,
  courierId: string,
  exceptDeliveryId?: string,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from deliveries
    where courier_id = ${courierId} and status in ('assigned', 'picked_up')
      ${exceptDeliveryId ? sql`and id <> ${exceptDeliveryId}` : sql``}`);
  return Number(rows[0]?.n ?? 0);
}

export async function openShiftOf(tx: Tx, courierId: string) {
  const [s] = await tx
    .select()
    .from(schema.shifts)
    .where(and(eq(schema.shifts.courierId, courierId), sql`${schema.shifts.closedAt} is null`));
  return s;
}

export type EventInput = {
  deliveryId: string;
  type: (typeof schema.eventType.enumValues)[number];
  from: DeliveryRow['status'] | null;
  to: DeliveryRow['status'] | null;
  actorId: string | null;
  actorRole: 'sender' | 'dispatcher' | 'courier' | 'system';
  deviceTime?: Date | null;
  at?: Date;
  payload?: Record<string, unknown>;
};

export async function addEvent(tx: Tx, e: EventInput): Promise<void> {
  await tx.insert(schema.deliveryEvents).values({
    deliveryId: e.deliveryId,
    type: e.type,
    fromStatus: e.from,
    toStatus: e.to,
    actorId: e.actorId,
    actorRole: e.actorRole,
    deviceTime: e.deviceTime ?? null,
    ...(e.at ? { serverTime: e.at } : {}),
    payload: e.payload ?? {},
  });
}

export const notFound = (what = 'Resource') => appError('NOT_FOUND', `${what} not found`);

export const toIso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
