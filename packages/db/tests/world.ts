import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assignDelivery,
  createDelivery,
  createProfiled,
  openShift,
  pickUpDelivery,
  type CreatedDelivery,
} from '../src/testing/fixtures';
import { createTestUser, signIn, type Session, type TestUser } from '../src/testing/users';
import type { Sql } from '../src/client';

export type World = {
  users: {
    senderA: TestUser;
    senderB: TestUser;
    courierA: TestUser;
    courierB: TestUser;
    dispatcher: TestUser;
    sneaky: TestUser;
  };
  sessions: {
    senderA: Session;
    senderB: Session;
    courierA: Session;
    courierB: Session;
    dispatcher: Session;
    sneaky: Session;
  };
  deliveries: { dA1: CreatedDelivery; dA2: CreatedDelivery; dB1: CreatedDelivery };
  shifts: { A: string; B: string };
  photos: { A: string; B: string };
  notificationIds: { A: string[]; B: string[] };
};

/**
 * Two senders, two couriers, a dispatcher and a "sneaky" user whose role sits only in user_metadata.
 * dA1 (assigned to courier A) and dA2 (unassigned) belong to sender A; dB1 (assigned to courier B) to sender B.
 */
export async function buildWorld(sql: Sql): Promise<World> {
  const senderA = await createProfiled(sql, 'sender');
  const senderB = await createProfiled(sql, 'sender');
  const courierA = await createProfiled(sql, 'courier');
  const courierB = await createProfiled(sql, 'courier');
  const dispatcher = await createProfiled(sql, 'dispatcher');
  const sneaky = await createTestUser('sender', {
    omitAppRole: true,
    userMetadataRole: 'dispatcher',
  });

  const shiftA = await openShift(sql, courierA.id);
  const shiftB = await openShift(sql, courierB.id);
  const dA1 = await createDelivery(sql, { senderId: senderA.id, codKop: 150_000 });
  const dA2 = await createDelivery(sql, { senderId: senderA.id });
  const dB1 = await createDelivery(sql, { senderId: senderB.id });
  await assignDelivery(sql, dA1.id, courierA.id, dispatcher.id);
  await pickUpDelivery(sql, dA1.id, courierA.id);
  await assignDelivery(sql, dB1.id, courierB.id, dispatcher.id);

  const photoA = randomUUID();
  const photoB = randomUUID();
  const hex = 'a'.repeat(64);
  await sql`insert into public.photos (id, delivery_id, courier_id, kind, storage_path, sha256, size_bytes, content_type)
    values (${photoA}, ${dA1.id}, ${courierA.id}, 'handover', ${`${dA1.id}/${photoA}.jpg`}, ${hex}, 10, 'image/jpeg'),
           (${photoB}, ${dB1.id}, ${courierB.id}, 'failed', ${`${dB1.id}/${photoB}.jpg`}, ${hex}, 10, 'image/jpeg')`;
  await sql`insert into public.courier_actions (courier_id, client_action_id, delivery_id, type, device_time, result)
    values (${courierA.id}, ${randomUUID()}, ${dA1.id}, 'pickup', now(), 'applied'),
           (${courierB.id}, ${randomUUID()}, ${dB1.id}, 'pickup', now(), 'applied')`;
  await sql`insert into public.cash_adjustments (shift_id, delivery_id, amount_kop, reason)
    values (${shiftA}, ${dA1.id}, 100, 'late offline delivery')`;
  const nA = await sql<
    { id: string }[]
  >`select id from public.notifications where sender_id = ${senderA.id}`;
  const nB = await sql<
    { id: string }[]
  >`select id from public.notifications where sender_id = ${senderB.id}`;
  for (const n of [...nA, ...nB]) {
    await sql`insert into public.notification_attempts (notification_id, http_status, duration_ms) values (${n.id}, 200, 5)`;
  }
  await sql`insert into public.idempotency_keys (sender_id, key, request_hash, delivery_id)
    values (${senderA.id}, ${`world-${randomUUID()}`}, 'h', ${dA1.id})`;

  const sessions = {
    senderA: await signIn(senderA.email, senderA.password),
    senderB: await signIn(senderB.email, senderB.password),
    courierA: await signIn(courierA.email, courierA.password),
    courierB: await signIn(courierB.email, courierB.password),
    dispatcher: await signIn(dispatcher.email, dispatcher.password),
    sneaky: await signIn(sneaky.email, sneaky.password),
  };
  return {
    users: { senderA, senderB, courierA, courierB, dispatcher, sneaky },
    sessions,
    deliveries: { dA1, dA2, dB1 },
    shifts: { A: shiftA, B: shiftB },
    photos: { A: photoA, B: photoB },
    notificationIds: { A: nA.map((r) => r.id), B: nB.map((r) => r.id) },
  };
}

export type Row = Record<string, unknown>;

/** Reads rows through PostgREST as `client`. A permission error counts as "nothing visible", reported separately. */
export async function readAs(
  client: SupabaseClient,
  table: string,
  column: string,
  values: string[],
  select = column,
): Promise<{ rows: Row[]; errorCode: string | null }> {
  const { data, error } = await client.from(table).select(select).in(column, values);
  return { rows: (data as unknown as Row[] | null) ?? [], errorCode: error?.code ?? null };
}
