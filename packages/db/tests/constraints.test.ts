import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DELIVERY_STATUSES,
  ZONES,
  canForceHandover,
  canTransition,
  codCommissionKop,
  deliveryFeeKop,
  type DeliveryStatus,
} from '@courier/shared';
import { useDb } from './db';
import {
  assignDelivery,
  createDelivery,
  driveTo,
  openShift,
  quickCourier,
  quickSender,
} from '../src/testing/fixtures';

const { sql } = useDb(35); // local Postgres allows 100 connections in total; Supabase itself uses ~50

const ACTORS = ['sender', 'dispatcher', 'courier', 'system'] as const;
const expectedAllowed = (from: DeliveryStatus, to: DeliveryStatus): boolean =>
  from === to ||
  ACTORS.some((a) => canTransition(from, to, a)) ||
  (to === 'delivered' && canForceHandover(from));

/** Column values that keep every CHECK constraint satisfied for a given target status. */
function patchFor(to: DeliveryStatus, courierId: string) {
  switch (to) {
    case 'assigned':
    case 'picked_up':
      return sql`status = ${to}, courier_id = ${courierId}`;
    case 'delivered':
      return sql`status = 'delivered', courier_id = ${courierId}, delivered_at = now(), cod_collected_kop = cod_kop`;
    default:
      return sql`status = ${to}, courier_id = null`;
  }
}

describe('status machine enforced by the database (every from × to)', () => {
  for (const from of DELIVERY_STATUSES) {
    for (const to of DELIVERY_STATUSES) {
      const allowed = expectedAllowed(from, to);
      it(`${from} → ${to} is ${allowed ? 'accepted' : 'rejected with DL001'}`, async () => {
        const senderId = await quickSender(sql);
        const courierId = await quickCourier(sql);
        const d = await createDelivery(sql, { senderId });
        await driveTo(sql, d.id, courierId, from);
        // a second courier for "assigned → assigned" (reassignment)
        const target = from === to && to === 'assigned' ? await quickCourier(sql) : courierId;
        const attempt = sql`update public.deliveries set ${patchFor(to, target)} where id = ${d.id}`;
        if (allowed) {
          await attempt;
          const [row] = await sql`select status from public.deliveries where id = ${d.id}`;
          expect(row!.status).toBe(to);
        } else {
          await expect(attempt).rejects.toMatchObject({ code: 'DL001' });
          const [row] = await sql`select status from public.deliveries where id = ${d.id}`;
          expect(row!.status).toBe(from); // nothing changed
        }
      });
    }
  }
});

describe('courier limit and shift rules (invariant 4 at the database level)', () => {
  it('rejects the 9th active delivery with DL002 and leaves exactly 8', async () => {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql);
    for (let i = 0; i < 8; i++) {
      const d = await createDelivery(sql, { senderId });
      await assignDelivery(sql, d.id, courierId);
    }
    const ninth = await createDelivery(sql, { senderId });
    await expect(assignDelivery(sql, ninth.id, courierId)).rejects.toMatchObject({ code: 'DL002' });
    const [cnt] = await sql<{ n: number }[]>`select count(*)::int n from public.deliveries
      where courier_id = ${courierId} and status in ('assigned','picked_up')`;
    expect(cnt!.n).toBe(8);
    const [row] =
      await sql`select status, courier_id from public.deliveries where id = ${ninth.id}`;
    expect(row).toMatchObject({ status: 'created', courier_id: null });
    // the failed assign was one transaction: no assignment row and no history either
    expect(
      await sql`select 1 from public.assignments where delivery_id = ${ninth.id}`,
    ).toHaveLength(0);
    expect(
      await sql`select 1 from public.delivery_events where delivery_id = ${ninth.id} and type = 'assigned'`,
    ).toHaveLength(0);
  });

  it('two concurrent assignments to a courier with 7 active: exactly one wins (50 rounds)', async () => {
    const senderId = await quickSender(sql);
    for (let round = 0; round < 50; round++) {
      const courierId = await quickCourier(sql);
      for (let i = 0; i < 7; i++) {
        const d = await createDelivery(sql, { senderId });
        await assignDelivery(sql, d.id, courierId);
      }
      const [a, b] = await Promise.all([
        createDelivery(sql, { senderId }),
        createDelivery(sql, { senderId }),
      ]);
      const results = await Promise.allSettled([
        assignDelivery(sql, a.id, courierId),
        assignDelivery(sql, b.id, courierId),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok, `round ${round}`).toBe(1);
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'DL002' });
      const [cnt] = await sql<{ n: number }[]>`select count(*)::int n from public.deliveries
        where courier_id = ${courierId} and status in ('assigned','picked_up')`;
      expect(cnt!.n).toBe(8);
    }
  });

  it('picked_up deliveries count towards the limit', async () => {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql);
    for (let i = 0; i < 8; i++) {
      const d = await createDelivery(sql, { senderId });
      await driveTo(sql, d.id, courierId, 'picked_up');
    }
    const extra = await createDelivery(sql, { senderId });
    await expect(assignDelivery(sql, extra.id, courierId)).rejects.toMatchObject({ code: 'DL002' });
  });

  it('delivered and failed deliveries do not count', async () => {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql);
    for (let i = 0; i < 12; i++) {
      const d = await createDelivery(sql, { senderId });
      await driveTo(sql, d.id, courierId, i % 2 ? 'delivered' : 'failed_attempt');
    }
    const next = await createDelivery(sql, { senderId });
    await assignDelivery(sql, next.id, courierId);
  });

  it('refuses couriers without an open shift (DL003); a shift opened later makes assignment work', async () => {
    const senderId = await quickSender(sql);
    const noShift = await quickCourier(sql, { shift: false });
    const d = await createDelivery(sql, { senderId });
    await expect(assignDelivery(sql, d.id, noShift)).rejects.toMatchObject({ code: 'DL003' });
    const [row] = await sql`select status from public.deliveries where id = ${d.id}`;
    expect(row!.status).toBe('created');
    await openShift(sql, noShift);
    await assignDelivery(sql, d.id, noShift);
  });

  it('a courier on a closed shift cannot receive deliveries', async () => {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql, { shift: false });
    const dispatcher = await quickSender(sql); // any profile id works for closed_by
    const [shift] = await sql<
      { id: string }[]
    >`insert into public.shifts (courier_id, opened_at, closed_at, closed_by,
      expected_cash_kop, handed_cash_kop, discrepancy_kop)
      values (${courierId}, now() - interval '2 hours', now() - interval '1 hour', ${dispatcher}, 0, 0, 0) returning id`;
    expect(shift).toBeTruthy();
    const d = await createDelivery(sql, { senderId });
    await expect(assignDelivery(sql, d.id, courierId)).rejects.toMatchObject({ code: 'DL003' });
  });

  it('only one open shift per courier, and closed-shift figures must be consistent', async () => {
    const courierId = await quickCourier(sql, { shift: false });
    await openShift(sql, courierId);
    await expect(openShift(sql, courierId)).rejects.toMatchObject({ code: '23505' });
    const closer = await quickSender(sql);
    await expect(
      sql`update public.shifts set closed_at = now(), closed_by = ${closer}, expected_cash_kop = 100,
        handed_cash_kop = 90, discrepancy_kop = 0 where courier_id = ${courierId}`,
    ).rejects.toMatchObject({ code: '23514' }); // discrepancy must equal handed - expected
    await sql`update public.shifts set closed_at = now(), closed_by = ${closer}, expected_cash_kop = 100,
      handed_cash_kop = 90, discrepancy_kop = -10 where courier_id = ${courierId}`;
    await openShift(sql, courierId); // a new shift may be opened after closing
  });
});

describe('one active assignment per delivery (invariant 3 backstop)', () => {
  it('two concurrent active assignment rows for one delivery: one insert fails with 23505', async () => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId });
    const [c1, c2] = [await quickCourier(sql), await quickCourier(sql)];
    const results = await Promise.allSettled([
      sql`insert into public.assignments (delivery_id, courier_id) values (${d.id}, ${c1})`,
      sql`insert into public.assignments (delivery_id, courier_id) values (${d.id}, ${c2})`,
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: '23505' });
  });

  it('an ended assignment does not block a new one', async () => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId });
    const [c1, c2] = [await quickCourier(sql), await quickCourier(sql)];
    await sql`insert into public.assignments (delivery_id, courier_id, ended_at, end_reason)
      values (${d.id}, ${c1}, now(), 'reassigned')`;
    await sql`insert into public.assignments (delivery_id, courier_id) values (${d.id}, ${c2})`;
  });

  it('ended_at and end_reason must be set together', async () => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId });
    const c = await quickCourier(sql);
    await expect(
      sql`insert into public.assignments (delivery_id, courier_id, ended_at) values (${d.id}, ${c}, now())`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('immutable columns and insert rules', () => {
  const cases: [string, string][] = [
    ['number', 'number = number + 1000'],
    ['zone', "zone = 'C'"],
    ['weight_g', 'weight_g = 2'],
    ['cod_kop', 'cod_kop = 5'],
    ['fee_kop', 'fee_kop = 1'],
    ['total_kop', 'total_kop = 1'],
    ['recipient_phone', "recipient_phone = '+380500000000'"],
    ['recipient_name', "recipient_name = 'Someone Else'"],
    ['address', `address = '{"city":"x","street":"y","house":"1"}'::jsonb`],
    [
      'sender_id',
      'sender_id = (select user_id from public.senders where user_id <> deliveries.sender_id limit 1)',
    ],
    ['created_at', "created_at = now() - interval '1 year'"],
  ];
  it.each(cases)('changing %s is refused with DL004', async (_col, assignment) => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId, zone: 'B', weightG: 1500 });
    await expect(
      sql.unsafe(`update public.deliveries set ${assignment} where id = '${d.id}'`),
    ).rejects.toMatchObject({
      code: 'DL004',
    });
  });

  it('inserting a delivery in any status other than created is refused (DL005)', async () => {
    const senderId = await quickSender(sql);
    await expect(
      sql`insert into public.deliveries (sender_id, status, recipient_name, recipient_phone, address, zone, weight_g, fee_kop, cod_commission_kop, total_kop)
        values (${senderId}, 'picked_up', 'x', '+380671234567', '{}'::jsonb, 'A', 1000, 6000, 0, 6000)`,
    ).rejects.toMatchObject({ code: 'DL005' });
  });

  it('a caller-supplied number is ignored: numbers only come from the counter', async () => {
    const senderId = await quickSender(sql);
    const [row] = await sql<{ number: number }[]>`
      insert into public.deliveries (sender_id, number, recipient_name, recipient_phone, address, zone, weight_g, fee_kop, cod_commission_kop, total_kop)
      values (${senderId}, 7, 'x', '+380671234567', '{}'::jsonb, 'A', 1000, 6000, 0, 6000) returning number`;
    expect(Number(row!.number)).toBeGreaterThan(50000);
  });

  it('version and updated_at move on every update', async () => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId });
    const [before] =
      await sql`select version, updated_at from public.deliveries where id = ${d.id}`;
    await sql`update public.deliveries set next_attempt_at = now() where id = ${d.id}`;
    const [after] = await sql`select version, updated_at from public.deliveries where id = ${d.id}`;
    expect(after!.version).toBe(before!.version + 1);
    expect(after!.updated_at.getTime()).toBeGreaterThanOrEqual(before!.updated_at.getTime());
  });
});

describe('gapless numbering (invariant 2)', () => {
  it('50 concurrent creates plus 20 that roll back: numbers stay 1..N with no holes or repeats', async () => {
    const senderId = await quickSender(sql);
    const creators = Array.from({ length: 50 }, () => createDelivery(sql, { senderId }));
    const rollers = Array.from({ length: 20 }, () =>
      sql
        .begin(async (tx) => {
          await tx`insert into public.deliveries (sender_id, recipient_name, recipient_phone, address, zone, weight_g, fee_kop, cod_commission_kop, total_kop)
            values (${senderId}, 'x', '+380671234567', '{}'::jsonb, 'A', 1000, 6000, 0, 6000)`;
          throw new Error('boom');
        })
        .catch(() => undefined),
    );
    const created = (await Promise.all([...creators, ...rollers])).filter(Boolean) as {
      number: number;
    }[];
    expect(created).toHaveLength(50);
    const numbers = created.map((c) => c.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(50);
    // the 50 numbers are one contiguous run: rolled-back inserts gave their numbers back
    expect(numbers[49]! - numbers[0]!).toBe(49);
    const [g] = await sql<{ n: number; mx: number; mn: number; counter: number }[]>`
      select count(*)::int n, max(number)::int mx, min(number)::int mn,
        (select value::int from public.delivery_number_counter) counter from public.deliveries`;
    expect(g).toMatchObject({ mn: 1 });
    expect(g!.n).toBe(g!.mx); // no holes anywhere
    expect(g!.counter).toBe(g!.mx);
  });

  it('public numbers are formatted DLV-000123 and widen beyond 6 digits instead of truncating', async () => {
    const [row] = await sql<{ a: string; b: string; c: string }[]>`
      select ('DLV-' || case when 123 >= 1000000 then '123' else lpad('123', 6, '0') end) a,
             ('DLV-' || case when 1234567 >= 1000000 then '1234567' else lpad('1234567', 6, '0') end) b,
             (select public_number from public.deliveries where number = 50000) c`;
    expect(row!.a).toBe('DLV-000123');
    expect(row!.b).toBe('DLV-1234567');
    expect(row!.c).toBe('DLV-050000');
  });
});

describe('pricing constraints', () => {
  const insertWith = (over: Record<string, unknown>) => {
    const base = {
      zone: 'A',
      weight: 1000,
      cod: 0,
      fee: 6000,
      comm: 0,
      total: 6000,
      phone: '+380671234567',
      attempt: 1,
    };
    const v = { ...base, ...over };
    return quickSender(sql).then(
      (
        senderId,
      ) => sql`insert into public.deliveries (sender_id, recipient_name, recipient_phone, address, zone, weight_g, cod_kop,
        fee_kop, cod_commission_kop, total_kop, attempt_no)
        values (${senderId}, 'x', ${v.phone as string}, '{}'::jsonb, ${v.zone as string}, ${v.weight as number}, ${v.cod as number},
        ${v.fee as number}, ${v.comm as number}, ${v.total as number}, ${v.attempt as number})`,
    );
  };

  it('accepts a correct row', async () => {
    await insertWith({});
  });
  it.each([
    ['a wrong fee', { fee: 5999, total: 5999 }, 'deliveries_price_fee'],
    ['a wrong commission', { cod: 100000, comm: 1999, total: 7999 }, 'deliveries_price_commission'],
    ['a wrong total', { total: 6001 }, 'deliveries_price_total'],
    ['a commission on zero COD', { comm: 2000, total: 8000 }, 'deliveries_price_commission'],
    [
      'no minimum commission (COD 1 kop)',
      { cod: 1, comm: 0, total: 6000 },
      'deliveries_price_commission',
    ],
  ])('rejects %s', async (_n, over, constraint) => {
    await expect(insertWith(over)).rejects.toMatchObject({
      code: '23514',
      constraint_name: constraint,
    });
  });
  it.each([
    ['weight 0', { weight: 0 }],
    ['weight 30001', { weight: 30001, fee: 29200 + 800 }],
    ['negative COD', { cod: -1 }],
    ['COD above 100 000 UAH', { cod: 10_000_001 }],
    ['attempt 0', { attempt: 0 }],
    ['attempt 4', { attempt: 4 }],
    ['phone without plus', { phone: '380671234567' }],
    ['phone with letters', { phone: '+38067abc4567' }],
    ['phone too short', { phone: '+1234567' }],
  ])('rejects %s', async (_n, over) => {
    await expect(insertWith(over)).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects a lowercase or unknown zone (enum)', async () => {
    await expect(insertWith({ zone: 'a' })).rejects.toMatchObject({ code: '22P02' });
    await expect(insertWith({ zone: 'D' })).rejects.toMatchObject({ code: '22P02' });
  });

  it('SQL pricing equals the TypeScript pricing for boundaries and 4000 random inputs', async () => {
    const weights = [
      1, 999, 1000, 1001, 1999, 2000, 2001, 14999, 15000, 15001, 29000, 29001, 29999, 30000,
    ];
    const cods = [
      0, 1, 99_999, 100_000, 100_024, 100_025, 100_026, 100_075, 123_450, 9_999_999, 10_000_000,
    ];
    const rows: { z: string; w: number; c: number }[] = [];
    for (const z of ZONES) for (const w of weights) for (const c of cods) rows.push({ z, w, c });
    rows.push(
      ...fc.sample(
        fc.record({
          z: fc.constantFrom(...ZONES),
          w: fc.integer({ min: 1, max: 30000 }),
          c: fc.integer({ min: 0, max: 10_000_000 }),
        }),
        4000,
      ),
    );
    const out = await sql<{ i: number; fee: number; comm: number }[]>`
      select t.i::int, app_private.calc_fee_kop(t.z::public.zone, t.w)::bigint fee,
             app_private.calc_cod_commission_kop(t.c)::bigint comm
      from unnest(${rows.map((r) => r.z)}::text[], ${rows.map((r) => r.w)}::int[], ${rows.map((r) => r.c)}::bigint[])
        with ordinality as t(z, w, c, i)`;
    expect(out).toHaveLength(rows.length);
    for (const o of out) {
      const r = rows[o.i - 1]!;
      expect(Number(o.fee), `fee ${r.z} ${r.w}`).toBe(deliveryFeeKop(r.z as 'A', r.w));
      expect(Number(o.comm), `commission ${r.c}`).toBe(codCommissionKop(r.c));
    }
  });
});

describe('delivery state constraints', () => {
  it('courier is attached exactly while assigned/picked_up/delivered', async () => {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql);
    const d = await createDelivery(sql, { senderId });
    await expect(
      sql`update public.deliveries set courier_id = ${courierId} where id = ${d.id}`,
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      sql`update public.deliveries set status = 'assigned' where id = ${d.id}`,
    ).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('a delivered row needs delivered_at and a collected sum equal to the COD amount', async () => {
    const senderId = await quickSender(sql);
    const courierId = await quickCourier(sql);
    const d = await createDelivery(sql, { senderId, codKop: 250_000 });
    await driveTo(sql, d.id, courierId, 'picked_up');
    await expect(
      sql`update public.deliveries set status = 'delivered', delivered_at = now(), cod_collected_kop = 249999 where id = ${d.id}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`update public.deliveries set status = 'delivered', cod_collected_kop = 250000 where id = ${d.id}`,
    ).rejects.toMatchObject({ code: '23514' });
    await sql`update public.deliveries set status = 'delivered', delivered_at = now(), cod_collected_kop = 250000 where id = ${d.id}`;
  });

  it('handover_blocked requires a streak of 5; the streak cannot exceed 5', async () => {
    const senderId = await quickSender(sql);
    const d = await createDelivery(sql, { senderId });
    await expect(
      sql`update public.deliveries set handover_blocked = true where id = ${d.id}`,
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      sql`update public.deliveries set wrong_code_streak = 6 where id = ${d.id}`,
    ).rejects.toMatchObject({
      code: '23514',
    });
    await sql`update public.deliveries set wrong_code_streak = 5, handover_blocked = true where id = ${d.id}`;
  });

  it('delivery secrets: code is 6 digits, tokens are unique', async () => {
    const senderId = await quickSender(sql);
    const a = await createDelivery(sql, { senderId });
    const b = await createDelivery(sql, { senderId });
    await expect(
      sql`update public.delivery_secrets set recipient_code = '12345' where delivery_id = ${a.id}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`update public.delivery_secrets set tracking_token = ${a.trackingToken} where delivery_id = ${b.id}`,
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      sql`update public.delivery_secrets set tracking_token = 'short' where delivery_id = ${b.id}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('idempotency keys are unique per sender but may repeat across senders', async () => {
    const [s1, s2] = [await quickSender(sql), await quickSender(sql)];
    const d1 = await createDelivery(sql, { senderId: s1 });
    const d2 = await createDelivery(sql, { senderId: s2 });
    const key = `key-${crypto.randomUUID()}`;
    await sql`insert into public.idempotency_keys (sender_id, key, request_hash, delivery_id) values (${s1}, ${key}, 'h', ${d1.id})`;
    await sql`insert into public.idempotency_keys (sender_id, key, request_hash, delivery_id) values (${s2}, ${key}, 'h', ${d2.id})`;
    await expect(
      sql`insert into public.idempotency_keys (sender_id, key, request_hash, delivery_id) values (${s1}, ${key}, 'h2', ${d2.id})`,
    ).rejects.toMatchObject({ code: '23505' });
  });
});
