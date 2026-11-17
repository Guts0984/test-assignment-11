import { describe, expect, it } from 'vitest';
import { useDb, rolledBack } from './db';
import {
  assignDelivery,
  createDelivery,
  pickUpDelivery,
  quickCourier,
  quickSender,
  sleep,
} from '../src/testing/fixtures';

const { sql } = useDb();

describe('transactional outbox (invariant 10, database part)', () => {
  it('writes one notification per status change, in order, with a stable id and a full payload', async () => {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql);
    const d = await createDelivery(sql, { senderId });
    await assignDelivery(sql, d.id, courierId);
    await pickUpDelivery(sql, d.id, courierId);
    await sql.begin(async (tx) => {
      await tx`update public.deliveries set status='delivered', delivered_at=now(), cod_collected_kop=cod_kop where id=${d.id}`;
      await tx`insert into public.delivery_events (delivery_id, type, from_status, to_status, actor_id, actor_role, device_time)
        values (${d.id}, 'delivered', 'picked_up', 'delivered', ${courierId}, 'courier', now() - interval '3 minutes')`;
    });
    const rows =
      await sql`select id, seq, event_type, status, attempts, payload from public.notifications
      where delivery_id = ${d.id} order by seq`;
    expect(rows.map((r) => [r.seq, r.event_type])).toEqual([
      [1, 'created'],
      [2, 'assigned'],
      [3, 'picked_up'],
      [4, 'delivered'],
    ]);
    for (const r of rows) {
      expect(r.status).toBe('pending');
      expect(r.attempts).toBe(0);
      expect(r.payload.id).toBe(r.id);
      expect(Object.keys(r.payload).sort()).toEqual(
        [
          'attemptNo',
          'deliveryId',
          'deviceTime',
          'event',
          'id',
          'number',
          'occurredAt',
          'previousStatus',
          'status',
        ].sort(),
      );
      expect(r.payload.deliveryId).toBe(d.id);
      expect(r.payload.number).toBe(d.publicNumber);
    }
    expect(rows[3]!.payload).toMatchObject({
      status: 'delivered',
      previousStatus: 'picked_up',
      event: 'delivered',
    });
    expect(rows[3]!.payload.deviceTime).not.toBeNull();
    expect(rows[0]!.payload.previousStatus).toBeNull();
  });

  it('a reassignment (no status change) does not notify the sender', async () => {
    const senderId = await quickSender(sql);
    const [c1, c2] = [await quickCourier(sql), await quickCourier(sql)];
    const d = await createDelivery(sql, { senderId });
    await assignDelivery(sql, d.id, c1);
    await sql.begin(async (tx) => {
      await tx`update public.deliveries set courier_id = ${c2}, assigned_at = now() where id = ${d.id}`;
      await tx`update public.assignments set ended_at = now(), end_reason = 'reassigned' where delivery_id = ${d.id} and ended_at is null`;
      await tx`insert into public.assignments (delivery_id, courier_id) values (${d.id}, ${c2})`;
      await tx`insert into public.delivery_events (delivery_id, type, from_status, to_status, actor_role)
        values (${d.id}, 'reassigned', 'assigned', 'assigned', 'dispatcher')`;
    });
    const [now] = await sql`select courier_id from public.deliveries where id = ${d.id}`;
    expect(now!.courier_id).toBe(c2);
    const n =
      await sql`select seq from public.notifications where delivery_id = ${d.id} order by seq`;
    expect(n.map((r) => r.seq)).toEqual([1, 2]); // created, assigned; nothing for the reassignment
  });

  it('events without a status change (wrong_code etc.) never notify', async () => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId });
    await sql`insert into public.delivery_events (delivery_id, type, actor_role, payload) values (${d.id}, 'wrong_code', 'courier', '{"streak":1}')`;
    const n = await sql`select 1 from public.notifications where delivery_id = ${d.id}`;
    expect(n).toHaveLength(1);
  });

  it('senders without a webhook get no outbox rows', async () => {
    const senderId = await quickSender(sql, { webhook: false });
    const d = await createDelivery(sql, { senderId });
    expect(await sql`select 1 from public.notifications where delivery_id = ${d.id}`).toHaveLength(
      0,
    );
  });

  it('a rolled-back status change leaves no notification behind (same transaction)', async () => {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql);
    const d = await createDelivery(sql, { senderId });
    await expect(
      sql.begin(async (tx) => {
        await tx`update public.deliveries set status='assigned', courier_id=${courierId}, assigned_at=now() where id=${d.id}`;
        await tx`insert into public.delivery_events (delivery_id, type, from_status, to_status, actor_role)
          values (${d.id}, 'assigned', 'created', 'assigned', 'dispatcher')`;
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(
      await sql`select seq from public.notifications where delivery_id = ${d.id}`,
    ).toHaveLength(1);
  });

  it('10 concurrent events for one delivery get distinct consecutive seq numbers (no unique violations)', async () => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId });
    const results = await Promise.allSettled(
      Array.from(
        { length: 10 },
        () => sql`insert into public.delivery_events (delivery_id, type, from_status, to_status, actor_role)
          values (${d.id}, 'picked_up', 'assigned', 'picked_up', 'courier')`,
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const seqs = (
      await sql`select seq from public.notifications where delivery_id = ${d.id} order by seq`
    ).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });

  it('notifications.seq is unique per delivery, and delivered status needs delivered_at', async () => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId });
    await expect(
      sql`insert into public.notifications (delivery_id, sender_id, seq, event_type, payload) values (${d.id}, ${senderId}, 1, 'created', '{}')`,
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      sql`update public.notifications set status = 'delivered' where delivery_id = ${d.id}`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('release_stale_assignments: the 45-minute pickup timeout (acceptance 4)', () => {
  async function staleFixture() {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql);
    const d = await createDelivery(sql, { senderId });
    await assignDelivery(sql, d.id, courierId);
    return { senderId, courierId, d };
  }

  const NOW = '2030-06-01T12:00:00Z'; // an explicit clock: tests never sleep for 45 minutes

  it.each([
    ['44 min 59 s old', 44 * 60 + 59, false],
    ['exactly 45 min old', 45 * 60, true],
    ['45 min 1 s old', 45 * 60 + 1, true],
    ['3 hours old', 3 * 3600, true],
    ['1 minute old', 60, false],
  ])('an assignment %s is %s released', async (_n, ageSeconds, released) => {
    const { d, courierId } = await staleFixture();
    await rolledBack(sql, async (tx) => {
      await tx`update public.deliveries set assigned_at = ${NOW}::timestamptz - make_interval(secs => ${ageSeconds}) where id = ${d.id}`;
      await tx`select app_private.release_stale_assignments(${NOW}::timestamptz)`;
      const [row] =
        await tx`select status, courier_id, assigned_at from public.deliveries where id = ${d.id}`;
      if (released) {
        expect(row).toMatchObject({ status: 'created', courier_id: null, assigned_at: null });
        const [a] =
          await tx`select ended_at, end_reason from public.assignments where delivery_id = ${d.id}`;
        expect(a!.end_reason).toBe('timeout');
        expect(a!.ended_at.toISOString()).toBe('2030-06-01T12:00:00.000Z');
        const [ev] =
          await tx`select type, from_status, to_status, actor_role, actor_id, server_time, payload
          from public.delivery_events where delivery_id = ${d.id} and type = 'released'`;
        expect(ev).toMatchObject({
          from_status: 'assigned',
          to_status: 'created',
          actor_role: 'system',
          actor_id: null,
        });
        expect(ev!.payload).toMatchObject({ reason: 'pickup_timeout', minutes: 45, courierId });
        expect(ev!.server_time.toISOString()).toBe('2030-06-01T12:00:00.000Z');
        const notes =
          await tx`select seq, event_type, payload from public.notifications where delivery_id = ${d.id} order by seq`;
        expect(notes.at(-1)).toMatchObject({ event_type: 'released' });
        expect(notes.at(-1)!.payload).toMatchObject({
          status: 'created',
          previousStatus: 'assigned',
        });
      } else {
        expect(row).toMatchObject({ status: 'assigned', courier_id: courierId });
        const [a] = await tx`select ended_at from public.assignments where delivery_id = ${d.id}`;
        expect(a!.ended_at).toBeNull();
        expect(
          await tx`select 1 from public.delivery_events where delivery_id = ${d.id} and type = 'released'`,
        ).toHaveLength(0);
      }
    });
  });

  it('never touches picked_up deliveries, however old', async () => {
    const { d, courierId } = await staleFixture();
    await pickUpDelivery(sql, d.id, courierId);
    await rolledBack(sql, async (tx) => {
      await tx`update public.deliveries set assigned_at = ${NOW}::timestamptz - interval '9 hours' where id = ${d.id}`;
      await tx`select app_private.release_stale_assignments(${NOW}::timestamptz)`;
      const [row] = await tx`select status, courier_id from public.deliveries where id = ${d.id}`;
      expect(row).toMatchObject({ status: 'picked_up', courier_id: courierId });
    });
  });

  it('is idempotent: a second run releases nothing more and writes no second event', async () => {
    const { d } = await staleFixture();
    await rolledBack(sql, async (tx) => {
      await tx`update public.deliveries set assigned_at = ${NOW}::timestamptz - interval '1 hour' where id = ${d.id}`;
      await tx`select app_private.release_stale_assignments(${NOW}::timestamptz)`;
      await tx`select app_private.release_stale_assignments(${NOW}::timestamptz)`;
      const ev =
        await tx`select 1 from public.delivery_events where delivery_id = ${d.id} and type = 'released'`;
      expect(ev).toHaveLength(1);
    });
  });

  it('a released delivery can be assigned again; the old assignment stays as history', async () => {
    const { d } = await staleFixture();
    const other = await quickCourier(sql);
    await rolledBack(sql, async (tx) => {
      await tx`update public.deliveries set assigned_at = ${NOW}::timestamptz - interval '1 hour' where id = ${d.id}`;
      await tx`select app_private.release_stale_assignments(${NOW}::timestamptz)`;
      await tx`update public.deliveries set status='assigned', courier_id=${other}, assigned_at=${NOW}::timestamptz where id = ${d.id}`;
      await tx`insert into public.assignments (delivery_id, courier_id, assigned_at) values (${d.id}, ${other}, ${NOW}::timestamptz)`;
      const hist =
        await tx`select courier_id, end_reason from public.assignments where delivery_id = ${d.id} order by assigned_at`;
      expect(hist.map((h) => h.end_reason)).toEqual(['timeout', null]);
    });
  });

  it('skips rows another transaction holds locked instead of waiting or double-releasing', async () => {
    const { d } = await staleFixture();
    await sql`update public.deliveries set assigned_at = now() - interval '2 hours' where id = ${d.id}`;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = sql.begin(async (tx) => {
      await tx`select id from public.deliveries where id = ${d.id} for update`;
      locked();
      await hold;
    });
    await lockedP;
    const started = Date.now();
    await rolledBack(sql, async (tx) => {
      await tx`select app_private.release_stale_assignments(now())`;
    });
    expect(Date.now() - started).toBeLessThan(5000); // did not block on the lock
    const [still] = await sql`select status from public.deliveries where id = ${d.id}`;
    expect(still!.status).toBe('assigned');
    release();
    await holder;
  });

  it('pg_cron is scheduled every minute and calls the function', async () => {
    const [job] =
      await sql`select schedule, command, active from cron.job where jobname = 'release-stale-assignments'`;
    expect(job).toMatchObject({ schedule: '* * * * *', active: true });
    expect(job!.command).toContain('app_private.release_stale_assignments');
  });

  it('REAL pg_cron run: a stale assignment is released by the scheduler within ~70 s (no manual call)', async () => {
    const { d } = await staleFixture();
    await sql`update public.deliveries set assigned_at = now() - interval '50 minutes' where id = ${d.id}`;
    let status = 'assigned';
    for (let i = 0; i < 40 && status === 'assigned'; i++) {
      await sleep(2000);
      const [row] = await sql`select status from public.deliveries where id = ${d.id}`;
      status = row!.status;
    }
    expect(status).toBe('created');
    const [ev] =
      await sql`select payload from public.delivery_events where delivery_id = ${d.id} and type = 'released'`;
    expect(ev!.payload).toMatchObject({ reason: 'pickup_timeout' });
  }, 120_000);

  it('the function cannot be called by anon or authenticated (not exposed, not granted)', async () => {
    const rows = await sql`
      select has_function_privilege('anon', 'app_private.release_stale_assignments(timestamptz)', 'execute') a,
             has_function_privilege('authenticated', 'app_private.release_stale_assignments(timestamptz)', 'execute') b,
             has_function_privilege('anon', 'app_private.next_delivery_number()', 'execute') c,
             has_function_privilege('authenticated', 'app_private.next_delivery_number()', 'execute') d`;
    expect(rows[0]).toEqual({ a: false, b: false, c: false, d: false });
  });
});
