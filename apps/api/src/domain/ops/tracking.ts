import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { schema } from '@courier/db';
import type { Ctx } from './common';
import { maskPhone, shortName, type TrackingView } from '../tracking';
import { TOKEN_PATTERN } from '../secrets';
import { notFound } from './common';

/** Public tracking view. Deliberately minimal: no full address, no full phone, no sender, no prices. */
export async function trackingView(ctx: Ctx, token: string): Promise<TrackingView> {
  if (!TOKEN_PATTERN.test(token)) throw notFound('Tracking link');
  const [row] = await ctx.db
    .select({ d: schema.deliveries, s: schema.deliverySecrets })
    .from(schema.deliverySecrets)
    .innerJoin(schema.deliveries, eq(schema.deliveries.id, schema.deliverySecrets.deliveryId))
    .where(eq(schema.deliverySecrets.trackingToken, token));
  if (!row) throw notFound('Tracking link');
  const [courier] = row.d.courierId
    ? await ctx.db
        .select({ name: schema.profiles.fullName })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, row.d.courierId))
    : [];
  const events = await ctx.db
    .select({
      to: schema.deliveryEvents.toStatus,
      at: schema.deliveryEvents.serverTime,
      type: schema.deliveryEvents.type,
    })
    .from(schema.deliveryEvents)
    .where(
      and(
        eq(schema.deliveryEvents.deliveryId, row.d.id),
        isNotNull(schema.deliveryEvents.toStatus),
      ),
    )
    .orderBy(asc(schema.deliveryEvents.id));
  const address = row.d.address;
  return {
    number: row.d.publicNumber ?? '',
    status: row.d.status,
    attemptNo: row.d.attemptNo,
    courierName: shortName(courier?.name ?? null),
    amountDueKop: row.d.codKop,
    code: row.s.recipientCode,
    channel: row.s.trackingChannel,
    city: address.city,
    street: address.street,
    phoneMasked: maskPhone(row.d.recipientPhone),
    updatedAt: row.d.updatedAt.toISOString(),
    timeline: events
      .filter((e) => e.type !== 'reassigned')
      .map((e) => ({ status: e.to!, at: e.at.toISOString() })),
  };
}
