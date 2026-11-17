import { and, asc, desc, eq, gte, inArray, like, lt, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@courier/db';
import {
  canCancel,
  canonicalJson,
  quote,
  startOfLocalDay,
  type CreateDeliveryInput,
  type DeliveryListQuery,
  type Role,
} from '@courier/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { appError } from '../errors';
import { generateCode, generateToken, sha256Hex } from '../secrets';
import { escapeLike, searchIntent } from '../search';
import { toPublicUrl } from '../urls';
import { addEvent, lockDelivery, notFound, type Ctx, type Tx } from './common';
import { dispatcherDto, eventDto, senderDto } from './dto';

const d = schema.deliveries;

/** Invariant 1: one delivery per (sender, Idempotency-Key). Same key + same body → same delivery; different body → 409. */
export async function createDelivery(
  ctx: Ctx,
  senderId: string,
  key: string,
  input: CreateDeliveryInput,
) {
  const hash = sha256Hex(canonicalJson(input));
  return ctx.db.transaction(async (tx) => {
    // Serialises concurrent requests with the same key: the second one waits here, then sees the first one's row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${senderId}:${key}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(schema.idempotencyKeys)
      .where(
        and(eq(schema.idempotencyKeys.senderId, senderId), eq(schema.idempotencyKeys.key, key)),
      );
    if (existing) {
      if (existing.requestHash !== hash) {
        throw appError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used with a different request body',
        );
      }
      const [row] = await tx.select().from(d).where(eq(d.id, existing.deliveryId));
      const [sec] = await tx
        .select()
        .from(schema.deliverySecrets)
        .where(eq(schema.deliverySecrets.deliveryId, existing.deliveryId));
      return { replay: true, delivery: senderDto(row!, { trackingToken: sec?.trackingToken }) };
    }

    const q = quote({ zone: input.zone, weightG: input.weightG, codKop: input.codKop });
    const [row] = await tx
      .insert(d)
      .values({
        senderId,
        recipientName: input.recipientName,
        recipientPhone: input.recipientPhone,
        address: input.address,
        zone: input.zone,
        weightG: input.weightG,
        codKop: input.codKop,
        feeKop: q.feeKop,
        codCommissionKop: q.codCommissionKop,
        totalKop: q.totalKop,
      })
      .returning();
    const trackingToken = generateToken();
    await tx.insert(schema.deliverySecrets).values({
      deliveryId: row!.id,
      recipientCode: generateCode(),
      trackingToken,
      trackingChannel: generateToken(),
    });
    await addEvent(tx, {
      deliveryId: row!.id,
      type: 'created',
      from: null,
      to: 'created',
      actorId: senderId,
      actorRole: 'sender',
    });
    await tx
      .insert(schema.idempotencyKeys)
      .values({ senderId, key, requestHash: hash, deliveryId: row!.id });
    return { replay: false, delivery: senderDto(row!, { trackingToken }) };
  });
}

/**
 * Invariant 5: cancel and pickup both lock the delivery row, so exactly one wins and everybody reads that one result.
 */
export async function cancelDelivery(ctx: Ctx, senderId: string, deliveryId: string) {
  return ctx.db.transaction(async (tx) => {
    const row = await lockDelivery(tx, deliveryId);
    // Someone else's delivery looks exactly like a missing one.
    if (!row || row.senderId !== senderId) throw notFound('Delivery');
    if (row.status === 'cancelled') return { delivery: senderDto(row), changed: false };
    if (row.status === 'picked_up')
      throw appError('ALREADY_PICKED_UP', 'The courier already picked this delivery up', {
        status: row.status,
      });
    if (!canCancel(row.status))
      throw appError('INVALID_STATUS', `A delivery that is ${row.status} cannot be cancelled`, {
        status: row.status,
      });
    const now = ctx.clock.now();
    const [updated] = await tx
      .update(d)
      .set({ status: 'cancelled', courierId: null, assignedAt: null })
      .where(eq(d.id, deliveryId))
      .returning();
    await tx
      .update(schema.assignments)
      .set({ endedAt: now, endReason: 'cancelled' })
      .where(
        and(
          eq(schema.assignments.deliveryId, deliveryId),
          sql`${schema.assignments.endedAt} is null`,
        ),
      );
    await addEvent(tx, {
      deliveryId,
      type: 'cancelled',
      from: row.status,
      to: 'cancelled',
      actorId: senderId,
      actorRole: 'sender',
      at: now,
      payload: { reason: 'sender_request' },
    });
    return { delivery: senderDto(updated!), changed: true };
  });
}

export type Viewer = { id: string; role: Extract<Role, 'sender' | 'dispatcher'> };

function dayRange(from?: string, to?: string): SQL[] {
  const out: SQL[] = [];
  const parse = (s: string) => s.split('-').map(Number) as [number, number, number];
  if (from) {
    const [y, m, dd] = parse(from);
    out.push(gte(d.createdAt, startOfLocalDay(y, m, dd)));
  }
  if (to) {
    const [y, m, dd] = parse(to);
    const next = new Date(Date.UTC(y, m - 1, dd + 1));
    out.push(
      lt(
        d.createdAt,
        startOfLocalDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
      ),
    );
  }
  return out;
}

export async function listDeliveries(ctx: Ctx, viewer: Viewer, q: DeliveryListQuery) {
  const conds: (SQL | undefined)[] = [];
  if (viewer.role === 'sender') conds.push(eq(d.senderId, viewer.id));
  if (q.status?.length) conds.push(inArray(d.status, q.status));
  conds.push(...dayRange(q.from, q.to));
  if (q.q) {
    const intent = searchIntent(q.q);
    const ors: SQL[] = [];
    if (intent.number !== undefined) ors.push(eq(d.number, intent.number));
    if (intent.phone) ors.push(eq(d.recipientPhone, intent.phone));
    if (intent.phonePrefix) ors.push(like(d.recipientPhone, `${escapeLike(intent.phonePrefix)}%`));
    // text that is neither a number nor a phone matches nothing, instead of everything
    conds.push(ors.length ? or(...ors) : sql`false`);
  }
  const where = and(...conds);
  const [count] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(d)
    .where(where);
  const rows = await ctx.db
    .select()
    .from(d)
    .where(where)
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return {
    items: rows.map((r) => (viewer.role === 'dispatcher' ? dispatcherDto(r) : senderDto(r))),
    total: count?.n ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  };
}

async function loadAccessible(tx: Tx | Ctx['db'], viewer: Viewer, id: string) {
  const [row] = await tx.select().from(d).where(eq(d.id, id));
  if (!row || (viewer.role === 'sender' && row.senderId !== viewer.id)) throw notFound('Delivery');
  return row;
}

export async function getCard(ctx: Ctx, viewer: Viewer, id: string) {
  const row = await loadAccessible(ctx.db, viewer, id);
  const [events, photos, secret, courier] = await Promise.all([
    ctx.db
      .select()
      .from(schema.deliveryEvents)
      .where(eq(schema.deliveryEvents.deliveryId, id))
      .orderBy(asc(schema.deliveryEvents.id)),
    ctx.db
      .select()
      .from(schema.photos)
      .where(eq(schema.photos.deliveryId, id))
      .orderBy(asc(schema.photos.createdAt)),
    viewer.role === 'sender'
      ? ctx.db
          .select()
          .from(schema.deliverySecrets)
          .where(eq(schema.deliverySecrets.deliveryId, id))
      : Promise.resolve([]),
    row.courierId
      ? ctx.db.select().from(schema.profiles).where(eq(schema.profiles.userId, row.courierId))
      : Promise.resolve([]),
  ]);
  const courierName = courier[0]?.fullName ?? null;
  const base =
    viewer.role === 'dispatcher'
      ? dispatcherDto(row, { courierName })
      : senderDto(row, {
          trackingToken: secret[0]?.trackingToken,
          courierName: courierName
            ? courierName.split(' ')[0]! + ' ' + (courierName.split(' ')[1]?.[0] ?? '') + '.'
            : null,
        });
  return {
    delivery: base,
    events: events.map((e) => eventDto(e, viewer.role)),
    photos: photos.map((p) => ({ id: p.id, kind: p.kind, createdAt: p.createdAt.toISOString() })),
  };
}

/** Short-lived signed URLs: senders get their own deliveries' photos, dispatchers everything. */
export async function signedPhotoUrls(
  ctx: Ctx,
  storage: SupabaseClient,
  viewer: Viewer,
  id: string,
) {
  await loadAccessible(ctx.db, viewer, id);
  const photos = await ctx.db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.deliveryId, id))
    .orderBy(asc(schema.photos.createdAt));
  const ttl = ctx.env.SIGNED_URL_TTL_SECONDS;
  const items = await Promise.all(
    photos.map(async (p) => {
      const { data, error } = await storage.storage
        .from(ctx.env.PHOTO_BUCKET)
        .createSignedUrl(p.storagePath, ttl);
      if (error || !data) throw appError('INTERNAL', 'Could not sign photo URL');
      return {
        id: p.id,
        kind: p.kind,
        url: toPublicUrl(data.signedUrl, ctx.env.internalSupabaseUrl, ctx.env.SUPABASE_URL),
        expiresAt: new Date(ctx.clock.now().getTime() + ttl * 1000).toISOString(),
      };
    }),
  );
  return { items };
}
