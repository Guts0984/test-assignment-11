import { describe, expect, it } from 'vitest';
import { DELIVERY_STATUSES } from '@courier/shared';
import { useDb } from './db';
import { DEMO, signIn } from '../src/testing/users';

const { sql } = useDb(5);

const SEED_SENDERS = [1, 2, 3].map(DEMO.senderId);
const SEED_COURIERS = Array.from({ length: 30 }, (_, i) => DEMO.courierId(i + 1));

const one = async <T extends object>(q: Promise<T[]>): Promise<T> => (await q)[0]!;

describe('seed: shape (3 senders, 2 dispatchers, 30 couriers, 50 000 deliveries / 90 days)', () => {
  it('has the documented people', async () => {
    const rows = await sql`select role, count(*)::int n from public.profiles
      where user_id::text ~ '^(a|d|c)0000000-0000-4000-8000-' group by role order by role::text`;
    expect(rows.map((r) => [r.role, r.n])).toEqual([
      ['courier', 30],
      ['dispatcher', 2],
      ['sender', 3],
    ]);
  });

  it('has 50 000 seeded deliveries with numbers exactly 1..50000', async () => {
    const r = await one(sql<{ n: number; d: number; mn: number; mx: number }[]>`
      select count(*)::int n, count(distinct number)::int d, min(number)::int mn, max(number)::int mx
      from public.deliveries where sender_id = any(${SEED_SENDERS})`);
    expect(r).toMatchObject({ n: 50000, d: 50000, mn: 1, mx: 50000 });
  });

  it('spreads creation dates over the last 90 days and nothing lies in the future', async () => {
    const r = await one(sql<{ oldest_days: number; newest_days: number }[]>`
      select extract(epoch from now() - min(created_at)) / 86400 as oldest_days,
             extract(epoch from now() - max(created_at)) / 86400 as newest_days
      from public.deliveries where sender_id = any(${SEED_SENDERS})`);
    expect(Number(r.oldest_days)).toBeGreaterThan(85);
    expect(Number(r.oldest_days)).toBeLessThan(91);
    expect(Number(r.newest_days)).toBeLessThan(1);
    const future = await one(sql<{ n: number }[]>`select (
        (select count(*) from public.deliveries where sender_id = any(${SEED_SENDERS}) and (created_at > now() or updated_at > now() or delivered_at > now()))
      + (select count(*) from public.delivery_events e join public.deliveries d on d.id = e.delivery_id where d.sender_id = any(${SEED_SENDERS}) and e.server_time > now())
      + (select count(*) from public.assignments a join public.deliveries d on d.id = a.delivery_id where d.sender_id = any(${SEED_SENDERS}) and (a.assigned_at > now() or a.ended_at > now()))
      + (select count(*) from public.shifts where courier_id = any(${SEED_COURIERS}) and (opened_at > now() or closed_at > now())))::int n`);
    expect(future.n).toBe(0);
  });

  it('contains every status (current state for stable ones, history for the rest)', async () => {
    const seen =
      await sql`select distinct to_status from public.delivery_events where to_status is not null`;
    expect(seen.map((r) => r.to_status).sort()).toEqual([...DELIVERY_STATUSES].sort());
    const now = await sql`select status, count(*)::int n from public.deliveries
      where sender_id = any(${SEED_SENDERS}) group by status`;
    const byStatus = Object.fromEntries(now.map((r) => [r.status, r.n]));
    expect(byStatus).toMatchObject({
      delivered: 44500,
      returned: 1500,
      cancelled: 3000,
      returning: 120,
      failed_attempt: 300,
      picked_up: 70,
    });
    expect(byStatus.created).toBeGreaterThanOrEqual(400); // + any assignment the 45-minute job already released
  });
});

describe('seed: internal consistency (these find generator bugs)', () => {
  it('no courier has more than 8 active deliveries, and every courier with active work is on shift', async () => {
    const rows = await sql`select courier_id, count(*)::int n from public.deliveries
      where status in ('assigned', 'picked_up') and courier_id = any(${SEED_COURIERS}) group by courier_id`;
    expect(Math.max(...rows.map((r) => r.n))).toBeLessThanOrEqual(8);
    const offShift = await sql`select d.courier_id from public.deliveries d
      where d.status in ('assigned','picked_up') and d.courier_id = any(${SEED_COURIERS})
        and not exists (select 1 from public.shifts s where s.courier_id = d.courier_id and s.closed_at is null)`;
    expect(offShift).toHaveLength(0);
  });

  it("every delivery's history is a valid chain: starts with created, each step continues the previous, ends at the current status", async () => {
    const broken = await sql`
      with ev as (
        select e.delivery_id, e.id, e.type, e.from_status, e.to_status,
               lag(e.to_status) over (partition by e.delivery_id order by e.id) as prev_to,
               row_number() over (partition by e.delivery_id order by e.id) as rn,
               last_value(e.to_status) over (partition by e.delivery_id order by e.id
                 rows between unbounded preceding and unbounded following) as last_to
        from public.delivery_events e join public.deliveries d on d.id = e.delivery_id
        where d.sender_id = any(${SEED_SENDERS}) and e.to_status is not null
      )
      select distinct ev.delivery_id from ev join public.deliveries d on d.id = ev.delivery_id
      where (rn = 1 and (type <> 'created' or from_status is not null))
         or (rn > 1 and from_status is distinct from prev_to)
         or last_to is distinct from d.status
      limit 5`;
    expect(broken).toEqual([]);
  });

  it('history timestamps never go backwards within a delivery', async () => {
    const bad = await sql`select count(*)::int n from (
      select e.server_time, lag(e.server_time) over (partition by e.delivery_id order by e.id) prev
      from public.delivery_events e join public.deliveries d on d.id = e.delivery_id
      where d.sender_id = any(${SEED_SENDERS})) x where prev > server_time`;
    expect(bad[0]!.n).toBe(0);
  });

  it('every legal transition in the seeded history is one the status machine allows', async () => {
    const bad = await sql`select count(*)::int n from public.delivery_events e
      where e.from_status is not null and e.from_status <> e.to_status
        and not app_private.is_valid_transition(e.from_status, e.to_status)`;
    expect(bad[0]!.n).toBe(0);
  });

  it('assignments: exactly one open row per assigned/picked_up delivery, none for the others', async () => {
    const mismatch = await sql`select count(*)::int n from public.deliveries d
      left join public.assignments a on a.delivery_id = d.id and a.ended_at is null
      where d.sender_id = any(${SEED_SENDERS})
        and ((d.status in ('assigned','picked_up')) <> (a.id is not null)
          or (a.id is not null and a.courier_id is distinct from d.courier_id))`;
    expect(mismatch[0]!.n).toBe(0);
    const delivered = await sql`select count(*)::int n from public.deliveries d
      where d.status = 'delivered' and d.sender_id = any(${SEED_SENDERS})
        and (select count(*) from public.assignments a where a.delivery_id = d.id and a.end_reason = 'delivered' and a.courier_id = d.courier_id) <> 1`;
    expect(delivered[0]!.n).toBe(0);
  });

  it('timestamps of delivered rows are ordered and inside the delivering courier’s shift', async () => {
    const bad = await sql`select count(*)::int n from public.deliveries d
      left join public.shifts s on s.id = d.delivered_shift_id
      where d.status = 'delivered' and d.sender_id = any(${SEED_SENDERS}) and (
        d.delivered_at < d.picked_up_at or d.picked_up_at < d.assigned_at or d.assigned_at < d.created_at
        or d.cod_collected_kop is distinct from d.cod_kop
        or s.id is null or s.courier_id <> d.courier_id
        or d.delivered_at < s.opened_at or d.delivered_at > coalesce(s.closed_at, now()))`;
    expect(bad[0]!.n).toBe(0);
  });

  it('cash adds up: every closed shift expects exactly what its deliveries collected', async () => {
    const bad = await sql`select count(*)::int n from public.shifts s
      where s.closed_at is not null and s.courier_id = any(${SEED_COURIERS})
        and s.expected_cash_kop <> coalesce((select sum(cod_collected_kop) from public.deliveries d where d.delivered_shift_id = s.id), 0)`;
    expect(bad[0]!.n).toBe(0);
  });

  it('some closed shifts have a recorded cash discrepancy, in both directions, but most are exact', async () => {
    const r = await one(sql<{ total: number; off: number; short: number; overpaid: number }[]>`
      select count(*)::int total, count(*) filter (where discrepancy_kop <> 0)::int off,
        count(*) filter (where discrepancy_kop < 0)::int short, count(*) filter (where discrepancy_kop > 0)::int overpaid
      from public.shifts where closed_at is not null and expected_cash_kop > 0 and courier_id = any(${SEED_COURIERS})`);
    expect(r.short).toBeGreaterThan(0);
    expect(r.overpaid).toBeGreaterThan(0);
    expect(r.off / r.total).toBeLessThan(0.2);
  });

  it('failed-attempt bookkeeping: next day, three attempts, then returning', async () => {
    const bad = await sql`select count(*)::int n from public.deliveries d
      where d.sender_id = any(${SEED_SENDERS}) and (
        (d.status = 'failed_attempt' and (d.next_attempt_at is null or d.attempt_no not between 1 and 2))
        or (d.status in ('returning','returned') and d.attempt_no <> 3)
        or (d.status not in ('failed_attempt') and d.next_attempt_at is not null))`;
    expect(bad[0]!.n).toBe(0);
    // next_attempt_at is a Kyiv midnight
    const notMidnight = await sql`select count(*)::int n from public.deliveries
      where status = 'failed_attempt' and sender_id = any(${SEED_SENDERS}) and (next_attempt_at at time zone 'Europe/Kyiv')::time <> '00:00'`;
    expect(notMidnight[0]!.n).toBe(0);
  });

  it('blocked-handover rows exist for the dispatcher to unblock', async () => {
    const r = await one(sql<{ blocked: number; partial: number }[]>`
      select count(*) filter (where handover_blocked)::int blocked,
             count(*) filter (where wrong_code_streak between 1 and 4)::int partial from public.deliveries`);
    expect(r.blocked).toBeGreaterThan(0);
    expect(r.partial).toBeGreaterThan(0);
  });

  it('every delivery has secrets; tokens are unique, long and URL safe; codes are 6 digits', async () => {
    const r = await one(sql<{ missing: number; dup: number; bad: number }[]>`
      select (select count(*)::int from public.deliveries d where d.sender_id = any(${SEED_SENDERS}) and not exists (select 1 from public.delivery_secrets s where s.delivery_id = d.id)) missing,
             (select (count(*) - count(distinct tracking_token))::int from public.delivery_secrets) dup,
             (select count(*)::int from public.delivery_secrets where tracking_token !~ '^[A-Za-z0-9_-]{22}$'
                or tracking_channel !~ '^[A-Za-z0-9_-]{22}$' or recipient_code !~ '^[0-9]{6}$') bad`);
    expect(r).toEqual({ missing: 0, dup: 0, bad: 0 });
  });

  it('seeded notifications are all delivered and numbered 1..n per delivery', async () => {
    // "released" notifications are produced live by the pg_cron job (and sent by the running worker): not seed history
    const r = await one(sql<{ pending: number; gaps: number }[]>`
      select count(*) filter (where status <> 'delivered')::int pending,
        (select count(*)::int from (
          select delivery_id from public.notifications
          where sender_id = any(${SEED_SENDERS}) and event_type <> 'released'
          group by delivery_id having count(*) <> max(seq) or min(seq) <> 1) g) gaps
      from public.notifications
      where sender_id = any(${SEED_SENDERS}) and event_type <> 'released' and created_at < now() - interval '1 hour'`);
    expect(r).toEqual({ pending: 0, gaps: 0 });
  });

  it('prices in the seed satisfy the tariff for every row', async () => {
    const bad = await sql`select count(*)::int n from public.deliveries
      where fee_kop <> app_private.calc_fee_kop(zone, weight_g)
         or cod_commission_kop <> app_private.calc_cod_commission_kop(cod_kop) or total_kop <> fee_kop + cod_commission_kop`;
    expect(bad[0]!.n).toBe(0);
    // the data exercises the tariff: every zone, light and heavy parcels, with and without COD
    const cover = await one(sql<
      { zones: number; light: number; heavy: number; cod: number; nocod: number }[]
    >`
      select count(distinct zone)::int zones, count(*) filter (where weight_g <= 1000)::int light,
        count(*) filter (where weight_g > 20000)::int heavy, count(*) filter (where cod_kop > 0)::int cod,
        count(*) filter (where cod_kop = 0)::int nocod from public.deliveries where sender_id = any(${SEED_SENDERS})`);
    expect(cover.zones).toBe(3);
    for (const k of ['light', 'heavy', 'cod', 'nocod'] as const)
      expect(cover[k]).toBeGreaterThan(100);
  });
});

describe('seed: demo logins from the README really work (GoTrue, real passwords)', () => {
  const logins: [string, string, string][] = [
    ...[1, 2, 3].map((n): [string, string, string] => [
      DEMO.sender(n),
      DEMO.senderPassword,
      'sender',
    ]),
    ...[1, 2].map((n): [string, string, string] => [
      DEMO.dispatcher(n),
      DEMO.dispatcherPassword,
      'dispatcher',
    ]),
    ...Array.from({ length: 30 }, (_, i): [string, string, string] => [
      DEMO.courier(i + 1),
      DEMO.courierPassword,
      'courier',
    ]),
  ];
  it.each(logins)('%s can sign in and has app_metadata.role %s', async (email, password, role) => {
    const s = await signIn(email, password);
    const claims = JSON.parse(Buffer.from(s.accessToken.split('.')[1]!, 'base64url').toString());
    expect(claims.app_metadata.role).toBe(role);
    expect(claims.sub).toBe(s.userId);
  });

  it('a wrong password is refused', async () => {
    await expect(signIn(DEMO.sender(1), 'wrong-password-1')).rejects.toThrow(/sign-in failed/);
  });
});
