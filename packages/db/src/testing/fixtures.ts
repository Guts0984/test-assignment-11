import { randomBytes, randomInt } from 'node:crypto';
import type postgres from 'postgres';
import {
  codCommissionKop,
  deliveryFeeKop,
  type DeliveryStatus,
  type Role,
  type Zone,
} from '@courier/shared';
import { createTestUser, type TestUser } from './users';

type Sql = ReturnType<typeof postgres>;

const token = () => randomBytes(16).toString('base64url');

export async function createProfiled(
  sql: Sql,
  role: Role,
  opts: { name?: string; webhook?: boolean } = {},
): Promise<TestUser> {
  const user = await createTestUser(role);
  const name = opts.name ?? `Test ${role} ${user.id.slice(0, 4)}`;
  await sql`insert into public.profiles (user_id, role, full_name) values (${user.id}, ${role}, ${name})`;
  if (role === 'sender') {
    await sql`insert into public.senders (user_id, company) values (${user.id}, 'Test Co')`;
    if (opts.webhook ?? true) {
      await sql`insert into public.sender_webhooks (sender_id, url, secret)
        values (${user.id}, 'http://localhost:5000/hook', 'whsec_test_secret')`;
    }
  }
  if (role === 'courier') await sql`insert into public.couriers (user_id) values (${user.id})`;
  return user;
}

export async function openShift(sql: Sql, courierId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into public.shifts (courier_id) values (${courierId}) returning id`;
  return row!.id;
}

export type NewDelivery = {
  senderId: string;
  zone?: Zone;
  weightG?: number;
  codKop?: number;
  phone?: string;
};

export type CreatedDelivery = {
  id: string;
  number: number;
  publicNumber: string;
  code: string;
  trackingToken: string;
  trackingChannel: string;
};

/** Inserts a `created` delivery plus its secrets, the way the API will (prices computed by @courier/shared). */
export async function createDelivery(sql: Sql, d: NewDelivery): Promise<CreatedDelivery> {
  const zone = d.zone ?? 'A';
  const weightG = d.weightG ?? 1000;
  const codKop = d.codKop ?? 0;
  const fee = deliveryFeeKop(zone, weightG);
  const commission = codCommissionKop(codKop);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const trackingToken = token();
  const trackingChannel = token();
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; number: number; public_number: string }[]>`
      insert into public.deliveries
        (sender_id, recipient_name, recipient_phone, address, zone, weight_g, cod_kop, fee_kop, cod_commission_kop, total_kop)
      values (${d.senderId}, 'Test Recipient', ${d.phone ?? '+380671234567'},
        ${tx.json({ city: 'Kyiv', street: 'Test St', house: '1' })}, ${zone}, ${weightG}, ${codKop},
        ${fee}, ${commission}, ${fee + commission})
      returning id, number, public_number`;
    await tx`insert into public.delivery_secrets (delivery_id, recipient_code, tracking_token, tracking_channel)
      values (${row!.id}, ${code}, ${trackingToken}, ${trackingChannel})`;
    await tx`insert into public.delivery_events (delivery_id, type, to_status, actor_id, actor_role)
      values (${row!.id}, 'created', 'created', ${d.senderId}, 'sender')`;
    return {
      id: row!.id,
      number: Number(row!.number),
      publicNumber: row!.public_number,
      code,
      trackingToken,
      trackingChannel,
    };
  });
}

/** Moves a delivery to `assigned` for a courier, with the assignment row and history, in one transaction. */
export async function assignDelivery(
  sql: Sql,
  deliveryId: string,
  courierId: string,
  assignedBy: string | null = null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [prev] = await tx<{ status: DeliveryStatus }[]>`
      select status from public.deliveries where id = ${deliveryId} for update`;
    await tx`update public.deliveries set status = 'assigned', courier_id = ${courierId}, assigned_at = now()
      where id = ${deliveryId}`;
    await tx`insert into public.assignments (delivery_id, courier_id, assigned_by)
      values (${deliveryId}, ${courierId}, ${assignedBy})`;
    await tx`insert into public.delivery_events (delivery_id, type, from_status, to_status, actor_id, actor_role)
      values (${deliveryId}, 'assigned', ${prev!.status}, 'assigned', ${assignedBy}, 'dispatcher')`;
  });
}

export async function pickUpDelivery(
  sql: Sql,
  deliveryId: string,
  courierId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`update public.deliveries set status = 'picked_up', picked_up_at = now() where id = ${deliveryId}`;
    await tx`insert into public.delivery_events (delivery_id, type, from_status, to_status, actor_id, actor_role)
      values (${deliveryId}, 'picked_up', 'assigned', 'picked_up', ${courierId}, 'courier')`;
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fast SQL-only user rows (no GoTrue). Good for DB-level tests that never log in. */
async function insertAuthUser(sql: Sql, role: Role): Promise<string> {
  const id = crypto.randomUUID();
  await sql`insert into auth.users (id, aud, role, email, raw_app_meta_data)
    values (${id}, 'authenticated', 'authenticated', ${`q-${id}@example.com`}, ${sql.json({ role })})`;
  return id;
}

export async function quickSender(sql: Sql, opts: { webhook?: boolean } = {}): Promise<string> {
  const id = await insertAuthUser(sql, 'sender');
  await sql`insert into public.profiles (user_id, role, full_name) values (${id}, 'sender', 'Quick Sender')`;
  await sql`insert into public.senders (user_id, company) values (${id}, 'Quick Co')`;
  if (opts.webhook ?? true) {
    await sql`insert into public.sender_webhooks (sender_id, url, secret)
      values (${id}, 'http://localhost:5000/hook', 'whsec_test_secret')`;
  }
  return id;
}

export async function quickCourier(sql: Sql, opts: { shift?: boolean } = {}): Promise<string> {
  const id = await insertAuthUser(sql, 'courier');
  await sql`insert into public.profiles (user_id, role, full_name) values (${id}, 'courier', 'Quick Courier')`;
  await sql`insert into public.couriers (user_id) values (${id})`;
  if (opts.shift ?? true) await openShift(sql, id);
  return id;
}

export async function quickDispatcher(sql: Sql): Promise<string> {
  const id = await insertAuthUser(sql, 'dispatcher');
  await sql`insert into public.profiles (user_id, role, full_name) values (${id}, 'dispatcher', 'Quick Dispatcher')`;
  return id;
}

/** Walks a fresh delivery along legal transitions until it reaches `target`. */
export async function driveTo(
  sql: Sql,
  deliveryId: string,
  courierId: string,
  target: DeliveryStatus,
): Promise<void> {
  const step = async (q: Promise<unknown>) => void (await q);
  if (target === 'created') return;
  if (target === 'cancelled') {
    await step(sql`update public.deliveries set status = 'cancelled' where id = ${deliveryId}`);
    return;
  }
  await assignDelivery(sql, deliveryId, courierId);
  if (target === 'assigned') return;
  await pickUpDelivery(sql, deliveryId, courierId);
  if (target === 'picked_up') return;
  if (target === 'delivered') {
    await step(sql`update public.deliveries set status = 'delivered', delivered_at = now(),
      cod_collected_kop = cod_kop where id = ${deliveryId}`);
    return;
  }
  await step(sql`update public.deliveries set status = 'failed_attempt', courier_id = null,
    assigned_at = null, picked_up_at = null where id = ${deliveryId}`);
  if (target === 'failed_attempt') return;
  await step(sql`update public.deliveries set status = 'returning' where id = ${deliveryId}`);
  if (target === 'returning') return;
  await step(sql`update public.deliveries set status = 'returned' where id = ${deliveryId}`);
}
