import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openShift } from '@courier/db/testing';
import {
  act,
  assign,
  call,
  codeOf,
  createViaApi,
  handoverReady,
  idemKey,
  jpeg,
  makeActors,
  pickedUp,
  sendActions,
  statusOf,
  uploadPhotoVia,
  useHarness,
  validBody,
  type DeliveryDto,
} from './harness';

const h = useHarness();
const T = 90_000;

describe('invariant 1: one delivery, one creator (Idempotency-Key)', () => {
  it('a repeat with the same key and body returns the same delivery (201 then 200 + Idempotent-Replay)', async () => {
    const a = await makeActors(h.sql);
    const key = idemKey();
    const first = await call<DeliveryDto>(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    const second = await call<DeliveryDto>(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.number).toBe(first.body.number);
    expect(second.body.trackingToken).toBe(first.body.trackingToken);
  });

  it(
    '10 parallel requests with one key create exactly one delivery (acceptance 6)',
    async () => {
      const a = await makeActors(h.sql);
      const key = idemKey();
      const rs = await Promise.all(
        Array.from({ length: 10 }, () =>
          call<DeliveryDto>(h, 'POST', '/deliveries', {
            token: a.sender.accessToken,
            body: validBody(),
            headers: { 'Idempotency-Key': key },
          }),
        ),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
      const [n] = await h.sql<
        { n: number }[]
      >`select count(*)::int n from public.deliveries where sender_id = ${a.sender.user.id}`;
      expect(n!.n).toBe(1);
      const [ev] = await h.sql<
        { n: number }[]
      >`select count(*)::int n from public.delivery_events where delivery_id = ${rs[0]!.body.id}`;
      expect(ev!.n).toBe(1);
    },
    T,
  );

  it('the same key with a different body is refused with 409, and creates nothing', async () => {
    const a = await makeActors(h.sql);
    const key = idemKey();
    await call(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    for (const change of [
      { weightG: 1501 },
      { zone: 'B' },
      { codKop: 1 },
      { recipientName: 'Someone Else' },
      { address: { city: 'Lviv', street: 'x', house: '1' } },
    ]) {
      const r = await call<{ error: { code: string } }>(h, 'POST', '/deliveries', {
        token: a.sender.accessToken,
        body: validBody(change),
        headers: { 'Idempotency-Key': key },
      });
      expect(r.status, JSON.stringify(change)).toBe(409);
      expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    const [n] = await h.sql<
      { n: number }[]
    >`select count(*)::int n from public.deliveries where sender_id = ${a.sender.user.id}`;
    expect(n!.n).toBe(1);
  });

  it(
    'parallel requests with one key but two different bodies: exactly one body wins, the other gets 409',
    async () => {
      const a = await makeActors(h.sql);
      const key = idemKey();
      const rs = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          call<DeliveryDto & { error?: { code: string } }>(h, 'POST', '/deliveries', {
            token: a.sender.accessToken,
            body: validBody({ weightG: i % 2 ? 1000 : 2000 }),
            headers: { 'Idempotency-Key': key },
          }),
        ),
      );
      const created = rs.filter((r) => r.status === 201);
      expect(created).toHaveLength(1);
      const winnerWeight = created[0]!.body.weightG;
      for (const r of rs) {
        if (r.status === 200) expect(r.body.weightG).toBe(winnerWeight);
        else if (r.status !== 201) expect(r.status).toBe(409);
      }
      const [n] = await h.sql<
        { n: number }[]
      >`select count(*)::int n from public.deliveries where sender_id = ${a.sender.user.id}`;
      expect(n!.n).toBe(1);
    },
    T,
  );

  it('the key is scoped per sender; key order inside the body does not matter', async () => {
    const a = await makeActors(h.sql);
    const key = idemKey();
    const r1 = await call<DeliveryDto>(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    const r2 = await call<DeliveryDto>(h, 'POST', '/deliveries', {
      token: a.sender2.accessToken,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    expect(r2.status).toBe(201);
    expect(r2.body.id).not.toBe(r1.body.id);
    const reordered = JSON.stringify({
      codKop: 0,
      weightG: 1500,
      zone: 'A',
      address: { apartment: '5', house: '22', street: 'Khreshchatyk', city: 'Kyiv' },
      recipientPhone: '+380671234567',
      recipientName: 'Olena Kovalenko',
    });
    const r3 = await call<DeliveryDto>(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      raw: reordered,
      contentType: 'application/json',
      headers: { 'Idempotency-Key': key },
    });
    expect(r3.status).toBe(200);
    expect(r3.body.id).toBe(r1.body.id);
  });

  it('a missing or malformed key is a 400, and an invalid body does not burn the key', async () => {
    const a = await makeActors(h.sql);
    const none = await call<{ error: { code: string } }>(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody(),
    });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    for (const bad of ['short', 'has space in it', 'x'.repeat(129)]) {
      const r = await call<{ error: { code: string } }>(h, 'POST', '/deliveries', {
        token: a.sender.accessToken,
        body: validBody(),
        headers: { 'Idempotency-Key': bad },
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
    }
    const key = idemKey();
    const invalid = await call(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody({ weightG: 0 }),
      headers: { 'Idempotency-Key': key },
    });
    expect(invalid.status).toBe(400);
    const ok = await call(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    expect(ok.status).toBe(201);
  });
});

describe('invariant 2: numbers DLV-… without gaps or repeats (acceptance 7)', () => {
  it(
    '50 concurrent creations produce 50 distinct consecutive numbers, and the sequence has no holes',
    async () => {
      const a = await makeActors(h.sql);
      const rs = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          call<DeliveryDto>(h, 'POST', '/deliveries', {
            token: a.sender.accessToken,
            body: validBody({ weightG: 100 + i }),
            headers: { 'Idempotency-Key': idemKey() },
          }),
        ),
      );
      expect(rs.every((r) => r.status === 201)).toBe(true);
      const nums = rs.map((r) => Number(r.body.number.slice(4))).sort((x, y) => x - y);
      expect(new Set(nums).size).toBe(50);
      expect(nums[49]! - nums[0]!).toBe(49);
      const [g] = await h.sql<
        { n: number; mx: number; mn: number }[]
      >`select count(*)::int n, max(number)::int mx, min(number)::int mn from public.deliveries`;
      expect(g!.mn).toBe(1);
      expect(g!.n).toBe(g!.mx);
    },
    T,
  );

  it('requests that fail validation or hit conflicts never consume a number', async () => {
    const a = await makeActors(h.sql);
    const [before] = await h.sql<
      { v: number }[]
    >`select value::int v from public.delivery_number_counter`;
    await Promise.all([
      ...Array.from({ length: 10 }, () =>
        call(h, 'POST', '/deliveries', {
          token: a.sender.accessToken,
          body: validBody({ weightG: -5 }),
          headers: { 'Idempotency-Key': idemKey() },
        }),
      ),
      ...Array.from({ length: 5 }, () =>
        call(h, 'POST', '/deliveries', {
          token: a.sender.accessToken,
          body: validBody({ zone: 'Z' }),
          headers: { 'Idempotency-Key': idemKey() },
        }),
      ),
    ]);
    const key = idemKey();
    await call(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    await call(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody({ weightG: 2 }),
      headers: { 'Idempotency-Key': key },
    }); // 409
    const [after] = await h.sql<
      { v: number }[]
    >`select value::int v from public.delivery_number_counter`;
    expect(after!.v - before!.v).toBe(1);
  });
});

describe('invariant 3: a delivery is never with two couriers (acceptance 8)', () => {
  it('two dispatchers assigning one delivery at once: one wins, one is told "already assigned" (25 rounds)', async () => {
    const a = await makeActors(h.sql);
    for (let i = 0; i < 25; i++) {
      const d = await createViaApi(h, a.sender.accessToken);
      const rs = await Promise.all([
        assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id),
        assign(h, a.dispatcher.accessToken, d.id, a.courier2.user.id),
      ]);
      expect(rs.map((r) => r.status).sort(), `round ${i}`).toEqual([200, 409]);
      expect(rs.find((r) => r.status === 409)!.body.error!.code).toBe('ALREADY_ASSIGNED');
      const act =
        await h.sql`select courier_id from public.assignments where delivery_id = ${d.id} and ended_at is null`;
      expect(act).toHaveLength(1);
      const [row] = await h.sql`select courier_id from public.deliveries where id = ${d.id}`;
      expect(row!.courier_id).toBe(act[0]!.courier_id);
      // free the slots again so the 8-limit never interferes with this test
      await call(h, 'POST', `/deliveries/${d.id}/cancel`, { token: a.sender.accessToken });
    }
  }, 180_000);

  it('10 dispatcher requests for one delivery: exactly one succeeds', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        assign(h, a.dispatcher.accessToken, d.id, (i % 2 ? a.courier : a.courier2).user.id),
      ),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(9);
  });
});

describe('invariant 4: a courier has at most 8 active deliveries (acceptance 8)', () => {
  it('a courier with 7 active gets two simultaneous assignments: exactly one passes (25 rounds)', async () => {
    const a = await makeActors(h.sql);
    for (let round = 0; round < 25; round++) {
      const c = (await makeActors(h.sql, { shifts: false })).courier;
      await openShift(h.sql, c.user.id);
      for (let i = 0; i < 7; i++) {
        const d = await createViaApi(h, a.sender.accessToken);
        expect((await assign(h, a.dispatcher.accessToken, d.id, c.user.id)).status).toBe(200);
      }
      const [x, y] = [
        await createViaApi(h, a.sender.accessToken),
        await createViaApi(h, a.sender.accessToken),
      ];
      const rs = await Promise.all([
        assign(h, a.dispatcher.accessToken, x.id, c.user.id),
        assign(h, a.dispatcher.accessToken, y.id, c.user.id),
      ]);
      expect(rs.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409]);
      const refusal = rs.find((r) => r.status === 409)!.body.error!;
      expect(refusal.code).toBe('COURIER_LIMIT_REACHED');
      expect(refusal.details).toMatchObject({ active: 8, limit: 8 });
      const [n] = await h.sql<
        { n: number }[]
      >`select count(*)::int n from public.deliveries where courier_id = ${c.user.id} and status in ('assigned','picked_up')`;
      expect(n!.n).toBe(8);
    }
  }, 300_000);

  it(
    '20 simultaneous assignments to a free courier: exactly 8 pass',
    async () => {
      const a = await makeActors(h.sql);
      const ds = await Promise.all(
        Array.from({ length: 20 }, () => createViaApi(h, a.sender.accessToken)),
      );
      const rs = await Promise.all(
        ds.map((d) => assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id)),
      );
      expect(rs.filter((r) => r.status === 200)).toHaveLength(8);
      expect(
        rs.filter((r) => r.status === 409 && r.body.error?.code === 'COURIER_LIMIT_REACHED'),
      ).toHaveLength(12);
    },
    T,
  );

  it(
    'picked_up counts, delivered/failed free the slot',
    async () => {
      const a = await makeActors(h.sql);
      const held = [];
      for (let i = 0; i < 8; i++) held.push(await pickedUp(h, a));
      const extra = await createViaApi(h, a.sender.accessToken);
      expect(
        (await assign(h, a.dispatcher.accessToken, extra.id, a.courier.user.id)).body.error?.code,
      ).toBe('COURIER_LIMIT_REACHED');
      const ph = await uploadPhotoVia(h, a.courier.accessToken, held[0]!.d.id, 'handover');
      expect(
        (
          await sendActions(h, a.courier.accessToken, [
            act.deliver(held[0]!.d.id, held[0]!.code, 0, ph.photoId),
          ])
        ).body.results[0]!.result,
      ).toBe('applied');
      expect((await assign(h, a.dispatcher.accessToken, extra.id, a.courier.user.id)).status).toBe(
        200,
      );
    },
    T,
  );
});

describe('invariant 5: cancel vs pickup has one outcome everyone agrees on (acceptance 9)', () => {
  it('40 races: the result is cancelled or picked_up, and sender, courier and tracking all see the same', async () => {
    const a = await makeActors(h.sql);
    const outcomes = { cancelled: 0, picked_up: 0 };
    for (let i = 0; i < 40; i++) {
      const d = await createViaApi(h, a.sender.accessToken);
      expect((await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id)).status).toBe(200);
      const [cancel, pick] = await Promise.all([
        call<{ error?: { code: string } }>(h, 'POST', `/deliveries/${d.id}/cancel`, {
          token: a.sender.accessToken,
        }),
        sendActions(h, a.courier.accessToken, [act.pickup(d.id)]),
      ]);
      const status = await statusOf(h.sql, d.id);
      const pickResult = pick.body.results[0]!;
      if (status === 'cancelled') {
        outcomes.cancelled++;
        expect(cancel.status).toBe(200);
        expect(pickResult.result).toBe('rejected');
        expect(pickResult.code).toBe('CANCELLED');
      } else {
        outcomes.picked_up++;
        expect(status).toBe('picked_up');
        expect(cancel.status).toBe(409);
        expect(cancel.body.error!.code).toBe('ALREADY_PICKED_UP');
        expect(pickResult.result).toBe('applied');
      }
      // every audience reads the same thing
      const card = await call<{ delivery: { status: string } }>(h, 'GET', `/deliveries/${d.id}`, {
        token: a.sender.accessToken,
      });
      expect(card.body.delivery.status).toBe(status);
      const track = await call<{ status: string }>(h, 'GET', `/tracking/${d.trackingToken}`);
      expect(track.body.status).toBe(status);
      const today = await call<{ deliveries: { id: string; status: string }[] }>(
        h,
        'GET',
        '/courier/today',
        { token: a.courier.accessToken },
      );
      const mine = today.body.deliveries.find((x) => x.id === d.id);
      expect(mine?.status ?? 'cancelled').toBe(status);
      // free the courier slot for the next round
      if (status === 'picked_up')
        await h.sql`update public.deliveries set status='failed_attempt', courier_id=null, assigned_at=null, picked_up_at=null, next_attempt_at=now() where id=${d.id}`;
    }
    expect(outcomes.cancelled + outcomes.picked_up).toBe(40);
  }, 300_000);
});

describe('invariant 6: the handover code cannot be brute-forced (acceptance 13)', () => {
  it(
    '20 parallel wrong codes: at most 5 are compared, the rest are refused as blocked',
    async () => {
      const a = await makeActors(h.sql);
      const { d, code, photoId } = await handoverReady(h, a);
      const wrong = code === '000000' ? '111111' : '000000';
      const rs = await Promise.all(
        Array.from({ length: 20 }, () =>
          sendActions(h, a.courier.accessToken, [act.deliver(d.id, wrong, 0, photoId)]),
        ),
      );
      const results = rs.map((r) => r.body.results[0]!);
      const compared = results.filter((r) => r.code === 'WRONG_CODE');
      const blocked = results.filter((r) => r.code === 'HANDOVER_BLOCKED');
      expect(compared).toHaveLength(5);
      expect(blocked).toHaveLength(15);
      const [row] =
        await h.sql`select wrong_code_streak, handover_blocked from public.deliveries where id = ${d.id}`;
      expect(row).toMatchObject({ wrong_code_streak: 5, handover_blocked: true });
      const [ev] = await h.sql<
        { n: number }[]
      >`select count(*)::int n from public.delivery_events where delivery_id = ${d.id} and type = 'wrong_code'`;
      expect(ev!.n).toBe(5);
      // even the right code is refused now
      const right = await sendActions(h, a.courier.accessToken, [
        act.deliver(d.id, code, 0, photoId),
      ]);
      expect(right.body.results[0]).toMatchObject({ result: 'rejected', code: 'HANDOVER_BLOCKED' });
      expect(await statusOf(h.sql, d.id)).toBe('picked_up');
    },
    T,
  );

  it('20 wrong codes in ONE batch behave the same', async () => {
    const a = await makeActors(h.sql);
    const { d, code, photoId } = await handoverReady(h, a);
    const wrong = code === '000000' ? '111111' : '000000';
    const r = await sendActions(
      h,
      a.courier.accessToken,
      Array.from({ length: 20 }, () => act.deliver(d.id, wrong, 0, photoId)),
    );
    expect(r.body.results.filter((x) => x.code === 'WRONG_CODE')).toHaveLength(5);
    expect(r.body.results.filter((x) => x.code === 'HANDOVER_BLOCKED')).toHaveLength(15);
    expect(r.body.results[4]!.details).toMatchObject({ blocked: true });
    expect(r.body.results[0]!.details).toMatchObject({ attemptsLeft: 4 });
  });

  it('the dispatcher can unblock; then the right code works and the streak is reset', async () => {
    const a = await makeActors(h.sql);
    const { d, code, photoId } = await handoverReady(h, a);
    const wrong = code === '000000' ? '111111' : '000000';
    await sendActions(
      h,
      a.courier.accessToken,
      Array.from({ length: 5 }, () => act.deliver(d.id, wrong, 0, photoId)),
    );
    const notDispatcher = await call(h, 'POST', `/dispatch/deliveries/${d.id}/unblock`, {
      token: a.courier.accessToken,
    });
    expect(notDispatcher.status).toBe(403);
    expect(
      (
        await call(h, 'POST', `/dispatch/deliveries/${d.id}/unblock`, {
          token: a.dispatcher.accessToken,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call<{ error: { code: string } }>(h, 'POST', `/dispatch/deliveries/${d.id}/unblock`, {
          token: a.dispatcher.accessToken,
        })
      ).status,
    ).toBe(409);
    const ok = await sendActions(h, a.courier.accessToken, [act.deliver(d.id, code, 0, photoId)]);
    expect(ok.body.results[0]!.result).toBe('applied');
    expect(await statusOf(h.sql, d.id)).toBe('delivered');
  });

  it('a correct code after 4 wrong ones still works, and resets the counter', async () => {
    const a = await makeActors(h.sql);
    const { d, code, photoId } = await handoverReady(h, a);
    const wrong = code === '000000' ? '111111' : '000000';
    await sendActions(
      h,
      a.courier.accessToken,
      Array.from({ length: 4 }, () => act.deliver(d.id, wrong, 0, photoId)),
    );
    const ok = await sendActions(h, a.courier.accessToken, [act.deliver(d.id, code, 0, photoId)]);
    expect(ok.body.results[0]!.result).toBe('applied');
    const [row] = await h.sql`select wrong_code_streak from public.deliveries where id = ${d.id}`;
    expect(row!.wrong_code_streak).toBe(0);
  });
});

describe('invariant 7: a courier action is applied once (acceptance 11)', () => {
  it('the same batch sent twice: the second answer is the stored one and nothing changes', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const batch = [act.pickup(d.id)];
    const first = await sendActions(h, a.courier.accessToken, batch);
    const [evBefore] = await h.sql<
      { n: number }[]
    >`select count(*)::int n from public.delivery_events where delivery_id = ${d.id}`;
    const second = await sendActions(h, a.courier.accessToken, batch);
    expect(first.body.results[0]).toMatchObject({ result: 'applied', status: 'picked_up' });
    expect(second.body.results[0]).toMatchObject({
      result: 'applied',
      status: 'picked_up',
      duplicate: true,
    });
    const [evAfter] = await h.sql<
      { n: number }[]
    >`select count(*)::int n from public.delivery_events where delivery_id = ${d.id}`;
    expect(evAfter!.n).toBe(evBefore!.n);
    const [n] = await h.sql<
      { n: number }[]
    >`select count(*)::int n from public.courier_actions where client_action_id = ${batch[0]!.clientActionId}`;
    expect(n!.n).toBe(1);
  });

  it(
    'the same batch sent 8 times IN PARALLEL is applied once (all answers agree)',
    async () => {
      const a = await makeActors(h.sql);
      const { d, code, photoId } = await handoverReady(h, a, { codKop: 12_345 });
      const batch = [act.deliver(d.id, code, 12_345, photoId)];
      const rs = await Promise.all(
        Array.from({ length: 8 }, () => sendActions(h, a.courier.accessToken, batch)),
      );
      for (const r of rs)
        expect(r.body.results[0]).toMatchObject({ result: 'applied', status: 'delivered' });
      expect(rs.filter((r) => !r.body.results[0]!.duplicate)).toHaveLength(1);
      const ev =
        await h.sql`select 1 from public.delivery_events where delivery_id = ${d.id} and type = 'delivered'`;
      expect(ev).toHaveLength(1);
      const notes =
        await h.sql`select 1 from public.notifications where delivery_id = ${d.id} and event_type = 'delivered'`;
      expect(notes).toHaveLength(1);
      const asg =
        await h.sql`select 1 from public.assignments where delivery_id = ${d.id} and end_reason = 'delivered'`;
      expect(asg).toHaveLength(1);
    },
    T,
  );

  it('a rejected action replays as the same rejection and is not retried against new state', async () => {
    const a = await makeActors(h.sql);
    const { d, photoId } = await handoverReady(h, a, { codKop: 5_000 });
    const wrongCod = act.deliver(d.id, await codeOf(h.sql, d.id), 4_999, photoId);
    const r1 = await sendActions(h, a.courier.accessToken, [wrongCod]);
    expect(r1.body.results[0]).toMatchObject({
      result: 'rejected',
      code: 'COD_MISMATCH',
      details: { expectedKop: 5_000 },
    });
    const r2 = await sendActions(h, a.courier.accessToken, [wrongCod]);
    expect(r2.body.results[0]).toMatchObject({
      result: 'rejected',
      code: 'COD_MISMATCH',
      duplicate: true,
    });
    expect(await statusOf(h.sql, d.id)).toBe('picked_up');
  });

  it('a batch is processed in order: pickup then deliver works in a single request', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover');
    const r = await sendActions(h, a.courier.accessToken, [
      act.pickup(d.id),
      act.deliver(d.id, await codeOf(h.sql, d.id), 0, photo.photoId),
    ]);
    expect(r.body.results.map((x) => x.result)).toEqual(['applied', 'applied']);
    expect(await statusOf(h.sql, d.id)).toBe('delivered');
  });

  it('two different couriers may use the same client action id independently', async () => {
    const a = await makeActors(h.sql);
    const d1 = await createViaApi(h, a.sender.accessToken);
    const d2 = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d1.id, a.courier.user.id);
    await assign(h, a.dispatcher.accessToken, d2.id, a.courier2.user.id);
    const id = randomUUID();
    const mk = (deliveryId: string) => ({
      type: 'pickup',
      clientActionId: id,
      deliveryId,
      deviceTime: new Date().toISOString(),
    });
    const [r1, r2] = await Promise.all([
      sendActions(h, a.courier.accessToken, [mk(d1.id)]),
      sendActions(h, a.courier2.accessToken, [mk(d2.id)]),
    ]);
    expect(r1.body.results[0]!.result).toBe('applied');
    expect(r2.body.results[0]!.result).toBe('applied');
  });

  it('a duplicated clientActionId inside one batch is a 400 (nothing applied)', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const p = act.pickup(d.id);
    const r = await call(h, 'POST', '/courier/actions', {
      token: a.courier.accessToken,
      body: { actions: [p, { ...p }] },
    });
    expect(r.status).toBe(400);
    expect(await statusOf(h.sql, d.id)).toBe('assigned');
  });
});

describe('invariant 8: a handover with the right code always counts (acceptance 10)', () => {
  it('delivery reassigned to another courier while the first was offline: the handover still counts, the second courier sees the removal', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken, { codKop: 77_700 });
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    // courier A goes offline holding the delivery; the dispatcher gives it to B and B picks it up
    expect((await assign(h, a.dispatcher.accessToken, d.id, a.courier2.user.id, true)).status).toBe(
      200,
    );
    expect(
      (await sendActions(h, a.courier2.accessToken, [act.pickup(d.id)])).body.results[0]!.result,
    ).toBe('applied');
    // A, still offline, did the work: pickup then handover, synced later
    const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover');
    const code = await codeOf(h.sql, d.id);
    const sync = await sendActions(h, a.courier.accessToken, [
      act.pickup(d.id),
      act.deliver(d.id, code, 77_700, photo.photoId),
    ]);
    expect(sync.body.results[0]).toMatchObject({ result: 'rejected', code: 'REASSIGNED' }); // the pickup cannot be honoured
    expect(sync.body.results[1]).toMatchObject({ result: 'applied', status: 'delivered' }); // the handover is
    const [row] =
      await h.sql`select status, courier_id, cod_collected_kop from public.deliveries where id = ${d.id}`;
    expect(row).toMatchObject({
      status: 'delivered',
      courier_id: a.courier.user.id,
      cod_collected_kop: 77_700,
    });
    const asg =
      await h.sql`select courier_id, end_reason from public.assignments where delivery_id = ${d.id} order by assigned_at`;
    // A's own row was closed by the reassignment; B held the delivery when A handed it over, so B's row says so
    expect(asg.map((x) => x.end_reason).sort()).toEqual(['delivered_by_other', 'reassigned']);
    // B is told
    const today = await call<{
      deliveries: { id: string }[];
      removed: { deliveryId: string; reason: string }[];
    }>(h, 'GET', '/courier/today', { token: a.courier2.accessToken });
    expect(today.body.deliveries.find((x) => x.id === d.id)).toBeUndefined();
    expect(today.body.removed.find((x) => x.deliveryId === d.id)).toMatchObject({
      reason: 'delivered_by_other',
    });
    // ... and if B tries to continue, the rejection explains why
    const bPhoto = await uploadPhotoVia(h, a.courier2.accessToken, d.id, 'handover');
    const late = await sendActions(h, a.courier2.accessToken, [
      act.deliver(d.id, code, 77_700, bPhoto.photoId),
    ]);
    expect(late.body.results[0]).toMatchObject({ result: 'rejected', code: 'INVALID_STATUS' });
  });

  it('when B still holds it (assigned) at the time A delivers, B gets "delivered_by_other"', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier2.user.id, true);
    const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover');
    const r = await sendActions(h, a.courier.accessToken, [
      act.deliver(d.id, await codeOf(h.sql, d.id), 0, photo.photoId),
    ]);
    expect(r.body.results[0]!.result).toBe('applied');
    const bRows =
      await h.sql`select end_reason from public.assignments where delivery_id = ${d.id} and courier_id = ${a.courier2.user.id}`;
    expect(bRows[0]!.end_reason).toBe('delivered_by_other');
    const today = await call<{ removed: { deliveryId: string; reason: string }[] }>(
      h,
      'GET',
      '/courier/today',
      { token: a.courier2.accessToken },
    );
    expect(today.body.removed.find((x) => x.deliveryId === d.id)).toMatchObject({
      reason: 'delivered_by_other',
    });
  });

  it('after the 45-minute release (delivery back in the queue) the handover still counts, and a late pickup retakes it', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    await h.sql`update public.deliveries set assigned_at = now() - interval '50 minutes' where id = ${d.id}`;
    await h.sql`select app_private.release_stale_assignments(now())`;
    expect(await statusOf(h.sql, d.id)).toBe('created');
    const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover');
    const r = await sendActions(h, a.courier.accessToken, [
      act.deliver(d.id, await codeOf(h.sql, d.id), 0, photo.photoId),
    ]);
    expect(r.body.results[0]).toMatchObject({ result: 'applied', status: 'delivered' });
    // a second delivery: the courier comes back online and had picked up in time
    const d2 = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d2.id, a.courier.user.id);
    await h.sql`update public.deliveries set assigned_at = now() - interval '50 minutes' where id = ${d2.id}`;
    await h.sql`select app_private.release_stale_assignments(now())`;
    const pk = await sendActions(h, a.courier.accessToken, [act.pickup(d2.id)]);
    expect(pk.body.results[0]).toMatchObject({ result: 'applied', status: 'picked_up' });
  });

  it('only a courier who was assigned the delivery can hand it over, even with the right code', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover'); // legit courier's photo
    const stranger = await sendActions(h, a.courier2.accessToken, [
      act.deliver(d.id, await codeOf(h.sql, d.id), 0, photo.photoId),
    ]);
    expect(stranger.body.results[0]).toMatchObject({
      result: 'rejected',
      code: 'NOT_YOUR_DELIVERY',
    });
    expect(await statusOf(h.sql, d.id)).toBe('assigned');
  });

  it('a cancelled delivery cannot be handed over; the rejection says why (invariant 9)', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    await call(h, 'POST', `/deliveries/${d.id}/cancel`, { token: a.sender.accessToken });
    const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover');
    const r = await sendActions(h, a.courier.accessToken, [
      act.deliver(d.id, await codeOf(h.sql, d.id), 0, photo.photoId),
    ]);
    expect(r.body.results[0]).toMatchObject({ result: 'rejected', code: 'CANCELLED' });
    expect(await statusOf(h.sql, d.id)).toBe('cancelled');
  });

  it('offline conflicts for pickup: cancelled and reassigned are rejected with a reason', async () => {
    const a = await makeActors(h.sql);
    const cancelled = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, cancelled.id, a.courier.user.id);
    await call(h, 'POST', `/deliveries/${cancelled.id}/cancel`, { token: a.sender.accessToken });
    const moved = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, moved.id, a.courier.user.id);
    await assign(h, a.dispatcher.accessToken, moved.id, a.courier2.user.id, true);
    const r = await sendActions(h, a.courier.accessToken, [
      act.pickup(cancelled.id),
      act.pickup(moved.id),
    ]);
    expect(r.body.results.map((x) => x.code)).toEqual(['CANCELLED', 'REASSIGNED']);
  });
});

describe('invariant 9: a rejected courier action is never lost silently', () => {
  it('every rejection is stored with its reason and listed for the courier; a reload gets the same list', async () => {
    const a = await makeActors(h.sql);
    const { d, photoId } = await handoverReady(h, a, { codKop: 100 });
    const wrongCode = act.deliver(
      d.id,
      '000000' === (await codeOf(h.sql, d.id)) ? '111111' : '000000',
      100,
      photoId,
    );
    const wrongCod = act.deliver(d.id, await codeOf(h.sql, d.id), 99, photoId);
    const noPhoto = act.deliver(d.id, await codeOf(h.sql, d.id), 100, randomUUID());
    const r = await sendActions(h, a.courier.accessToken, [wrongCode, wrongCod, noPhoto]);
    expect(r.body.results.map((x) => x.code)).toEqual([
      'WRONG_CODE',
      'COD_MISMATCH',
      'PHOTO_REQUIRED',
    ]);
    const list = await call<{
      items: { clientActionId: string; code: string; message: string; number: string }[];
    }>(h, 'GET', '/courier/actions/rejected', { token: a.courier.accessToken });
    expect(list.body.items.map((x) => x.code).sort()).toEqual([
      'COD_MISMATCH',
      'PHOTO_REQUIRED',
      'WRONG_CODE',
    ]);
    for (const it2 of list.body.items) {
      expect(it2.message.length).toBeGreaterThan(5);
      expect(it2.number).toBe(d.number);
    }
    // another courier never sees them
    const other = await call<{ items: unknown[] }>(h, 'GET', '/courier/actions/rejected', {
      token: a.courier2.accessToken,
    });
    expect(other.body.items).toHaveLength(0);
  });

  it('actions for unknown deliveries are answered with a rejection, not an error', async () => {
    const a = await makeActors(h.sql);
    const r = await sendActions(h, a.courier.accessToken, [act.pickup(randomUUID())]);
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ result: 'rejected', code: 'NOT_FOUND' });
  });
});

describe('invariant 11: cash adds up (acceptance 14)', () => {
  it(
    'expected cash = what was collected; a short hand-in is recorded as a discrepancy and shows in the report',
    async () => {
      const a = await makeActors(h.sql);
      const amounts = [10_000, 25_050, 0];
      const dels = [];
      for (const cod of amounts) dels.push(await handoverReady(h, a, { codKop: cod }));
      for (const x of dels) {
        const r = await sendActions(h, a.courier.accessToken, [
          act.deliver(x.d.id, x.code, x.d.codKop, x.photoId),
        ]);
        expect(r.body.results[0]!.result).toBe('applied');
      }
      const preview = await call<{ expectedCashKop: number; activeDeliveries: number }>(
        h,
        'GET',
        `/dispatch/couriers/${a.courier.user.id}/shift`,
        { token: a.dispatcher.accessToken },
      );
      expect(preview.body).toMatchObject({ expectedCashKop: 35_050, activeDeliveries: 0 });
      const close = await call<{
        expectedCashKop: number;
        handedCashKop: number;
        discrepancyKop: number;
      }>(h, 'POST', `/dispatch/couriers/${a.courier.user.id}/shift/close`, {
        token: a.dispatcher.accessToken,
        body: { handedCashKop: 34_000 },
      });
      expect(close.status).toBe(200);
      expect(close.body).toMatchObject({
        expectedCashKop: 35_050,
        handedCashKop: 34_000,
        discrepancyKop: -1_050,
      });
      const [s] =
        await h.sql`select expected_cash_kop, handed_cash_kop, discrepancy_kop, closed_by from public.shifts where courier_id = ${a.courier.user.id} and closed_at is not null`;
      expect(s).toMatchObject({
        expected_cash_kop: 35_050,
        handed_cash_kop: 34_000,
        discrepancy_kop: -1_050,
        closed_by: a.dispatcher.user.id,
      });
      const today = new Date().toISOString().slice(0, 10);
      const rep = await call<{
        cashDiscrepancies: { items: { courierId: string; discrepancyKop: number }[] };
      }>(h, 'GET', `/dispatch/report?from=${today}&to=${today}`, {
        token: a.dispatcher.accessToken,
      });
      expect(
        rep.body.cashDiscrepancies.items.find((i) => i.courierId === a.courier.user.id),
      ).toMatchObject({ discrepancyKop: -1_050 });
      // closing again, with no open shift, is refused
      const again = await call<{ error: { code: string } }>(
        h,
        'POST',
        `/dispatch/couriers/${a.courier.user.id}/shift/close`,
        { token: a.dispatcher.accessToken, body: { handedCashKop: 0 } },
      );
      expect(again.status).toBe(409);
    },
    T,
  );

  it('a shift cannot be closed while the courier has active deliveries', async () => {
    const a = await makeActors(h.sql);
    await pickedUp(h, a);
    const r = await call<{ error: { code: string; details: { active: number } } }>(
      h,
      'POST',
      `/dispatch/couriers/${a.courier.user.id}/shift/close`,
      { token: a.dispatcher.accessToken, body: { handedCashKop: 0 } },
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SHIFT_HAS_ACTIVE_DELIVERIES');
    expect(r.body.error.details.active).toBe(1);
    const [s] =
      await h.sql`select closed_at from public.shifts where courier_id = ${a.courier.user.id}`;
    expect(s!.closed_at).toBeNull();
  });

  it('a handover synced after the shift was closed is not lost: it lands in cash_adjustments', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken, { codKop: 40_000 });
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier2.user.id, true); // courier A holds nothing now
    const close = await call(h, 'POST', `/dispatch/couriers/${a.courier.user.id}/shift/close`, {
      token: a.dispatcher.accessToken,
      body: { handedCashKop: 0 },
    });
    expect(close.status).toBe(200);
    const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover');
    const r = await sendActions(h, a.courier.accessToken, [
      act.deliver(d.id, await codeOf(h.sql, d.id), 40_000, photo.photoId),
    ]);
    expect(r.body.results[0]!.result).toBe('applied');
    const adj =
      await h.sql`select amount_kop from public.cash_adjustments where delivery_id = ${d.id}`;
    expect(adj.map((x) => Number(x.amount_kop))).toEqual([40_000]);
  });

  it('closing a shift while a late handover arrives: collected, expected and adjustments always reconcile (20 races)', async () => {
    for (let i = 0; i < 20; i++) {
      const a = await makeActors(h.sql);
      const d = await createViaApi(h, a.sender.accessToken, { codKop: 5_000 });
      await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
      await assign(h, a.dispatcher.accessToken, d.id, a.courier2.user.id, true);
      const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover');
      const code = await codeOf(h.sql, d.id);
      const [close, del] = await Promise.all([
        call(h, 'POST', `/dispatch/couriers/${a.courier.user.id}/shift/close`, {
          token: a.dispatcher.accessToken,
          body: { handedCashKop: 0 },
        }),
        sendActions(h, a.courier.accessToken, [act.deliver(d.id, code, 5_000, photo.photoId)]),
      ]);
      expect(close.status).toBe(200);
      expect(del.body.results[0]!.result).toBe('applied');
      const [s] = await h.sql<
        { id: string; expected: number }[]
      >`select id, expected_cash_kop::int expected from public.shifts where courier_id = ${a.courier.user.id}`;
      const [attributed] = await h.sql<
        { total: number }[]
      >`select coalesce(sum(cod_collected_kop),0)::int total from public.deliveries where delivered_shift_id = ${s!.id}`;
      const [adjusted] = await h.sql<
        { total: number }[]
      >`select coalesce(sum(amount_kop),0)::int total from public.cash_adjustments where shift_id = ${s!.id}`;
      // either the delivery was counted in "expected" before the close, or it was recorded as a late adjustment: never neither, never both
      expect(s!.expected + adjusted!.total, `round ${i}`).toBe(attributed!.total);
      expect(attributed!.total).toBe(5_000);
    }
  }, 300_000);
});

describe('invariant 14: a photo is never lost and never duplicated (acceptance 17)', () => {
  it('re-sending the same photo id and bytes stores one file and one row', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const bytes = jpeg();
    const photoId = randomUUID();
    const first = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover', photoId, bytes);
    const second = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover', photoId, bytes);
    expect(first.res.status).toBe(200);
    expect((first.res.body as { duplicate: boolean }).duplicate).toBe(false);
    expect((second.res.body as { duplicate: boolean }).duplicate).toBe(true);
    expect(await h.sql`select 1 from public.photos where delivery_id = ${d.id}`).toHaveLength(1);
    const objs =
      await h.sql`select name from storage.objects where bucket_id = 'delivery-photos' and name like ${`${d.id}/%`}`;
    expect(objs).toHaveLength(1);
  });

  it('10 parallel uploads of one photo: one row, one stored object', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const bytes = jpeg();
    const photoId = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 10 }, () =>
        uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover', photoId, bytes),
      ),
    );
    expect(rs.every((r) => r.res.status === 200)).toBe(true);
    expect(rs.filter((r) => !(r.res.body as { duplicate: boolean }).duplicate)).toHaveLength(1);
    expect(await h.sql`select 1 from public.photos where delivery_id = ${d.id}`).toHaveLength(1);
    const objs =
      await h.sql`select name from storage.objects where bucket_id = 'delivery-photos' and name like ${`${d.id}/%`}`;
    expect(objs).toHaveLength(1);
  });

  it('the same id with different bytes is a conflict and the original stays', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const photoId = randomUUID();
    const orig = jpeg('original');
    await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover', photoId, orig);
    const r = await uploadPhotoVia(
      h,
      a.courier.accessToken,
      d.id,
      'handover',
      photoId,
      jpeg('different'),
    );
    expect(r.res.status).toBe(409);
    expect((r.res.body as { error: { code: string } }).error.code).toBe('PHOTO_CONFLICT');
    const [row] = await h.sql`select sha256 from public.photos where id = ${photoId}`;
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a handover recorded offline, with its photo, synced twice: one photo, visible to the sender via a signed URL', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const bytes = jpeg('proof-of-delivery');
    const photoId = randomUUID();
    const code = await codeOf(h.sql, d.id);
    const batch = [act.pickup(d.id), act.deliver(d.id, code, 0, photoId)];
    for (let i = 0; i < 2; i++) {
      await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover', photoId, bytes);
      const r = await sendActions(h, a.courier.accessToken, batch);
      expect(r.body.results.map((x) => x.result)).toEqual(['applied', 'applied']);
    }
    expect(await h.sql`select 1 from public.photos where delivery_id = ${d.id}`).toHaveLength(1);
    const urls = await call<{ items: { id: string; kind: string; url: string }[] }>(
      h,
      'GET',
      `/deliveries/${d.id}/photos`,
      { token: a.sender.accessToken },
    );
    expect(urls.status).toBe(200);
    expect(urls.body.items).toHaveLength(1);
    const file = await fetch(urls.body.items[0]!.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
    // other sender: 404, dispatcher: yes
    expect(
      (await call(h, 'GET', `/deliveries/${d.id}/photos`, { token: a.sender2.accessToken })).status,
    ).toBe(404);
    expect(
      (await call(h, 'GET', `/deliveries/${d.id}/photos`, { token: a.dispatcher.accessToken }))
        .status,
    ).toBe(200);
    expect(
      (await call(h, 'GET', `/deliveries/${d.id}/photos`, { token: a.courier.accessToken })).status,
    ).toBe(403);
  });

  it('rejects non-images (by content, not by header), oversized bodies, foreign deliveries and bad ids', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const html = await call<{ error: { code: string } }>(
      h,
      'PUT',
      `/courier/photos/${randomUUID()}?deliveryId=${d.id}&kind=handover`,
      { token: a.courier.accessToken, raw: '<script>alert(1)</script>', contentType: 'image/jpeg' },
    );
    expect(html.status).toBe(415);
    const big = await call(
      h,
      'PUT',
      `/courier/photos/${randomUUID()}?deliveryId=${d.id}&kind=handover`,
      {
        token: a.courier.accessToken,
        raw: Buffer.concat([jpeg(), Buffer.alloc(5_242_881)]),
        contentType: 'image/jpeg',
      },
    );
    expect(big.status).toBe(413);
    const foreign = await uploadPhotoVia(h, a.courier2.accessToken, d.id, 'handover');
    expect(foreign.res.status).toBe(404);
    const badId = await call(
      h,
      'PUT',
      `/courier/photos/not-a-uuid?deliveryId=${d.id}&kind=handover`,
      { token: a.courier.accessToken, raw: jpeg(), contentType: 'image/jpeg' },
    );
    expect(badId.status).toBe(400);
    const traversal = await call(
      h,
      'PUT',
      `/courier/photos/..%2F..%2Fetc%2Fpasswd?deliveryId=${d.id}&kind=handover`,
      { token: a.courier.accessToken, raw: jpeg(), contentType: 'image/jpeg' },
    );
    expect(traversal.status).toBe(400);
    const badKind = await call(
      h,
      'PUT',
      `/courier/photos/${randomUUID()}?deliveryId=${d.id}&kind=selfie`,
      { token: a.courier.accessToken, raw: jpeg(), contentType: 'image/jpeg' },
    );
    expect(badKind.status).toBe(400);
    const empty = await call(
      h,
      'PUT',
      `/courier/photos/${randomUUID()}?deliveryId=${d.id}&kind=handover`,
      { token: a.courier.accessToken, raw: Buffer.alloc(0), contentType: 'image/jpeg' },
    );
    expect(empty.status).toBe(400);
    const json = await call(
      h,
      'PUT',
      `/courier/photos/${randomUUID()}?deliveryId=${d.id}&kind=handover`,
      { token: a.courier.accessToken, body: { x: 1 } },
    );
    expect(json.status).toBe(415);
    expect(await h.sql`select 1 from public.photos where delivery_id = ${d.id}`).toHaveLength(0);
  });

  it('a handover/fail needs a photo of the right kind that belongs to this delivery', async () => {
    const a = await makeActors(h.sql);
    const x = await pickedUp(h, a);
    const y = await pickedUp(h, a);
    const wrongKind = await uploadPhotoVia(h, a.courier.accessToken, x.d.id, 'failed');
    const otherDelivery = await uploadPhotoVia(h, a.courier.accessToken, y.d.id, 'handover');
    const r = await sendActions(h, a.courier.accessToken, [
      act.deliver(x.d.id, x.code, 0, wrongKind.photoId),
      act.deliver(x.d.id, x.code, 0, otherDelivery.photoId),
      act.fail(x.d.id, otherDelivery.photoId),
    ]);
    expect(r.body.results.map((v) => v.code)).toEqual([
      'PHOTO_REQUIRED',
      'PHOTO_REQUIRED',
      'PHOTO_REQUIRED',
    ]);
    expect(await statusOf(h.sql, x.d.id)).toBe('picked_up');
  });
});

describe('transactions leave nothing behind when a request is refused', () => {
  it('a refused assignment writes no assignment, event or notification', async () => {
    const a = await makeActors(h.sql, { shifts: false });
    const d = await createViaApi(h, a.sender.accessToken);
    const before =
      await h.sql`select (select count(*) from public.delivery_events where delivery_id = ${d.id})::int e, (select count(*) from public.notifications where delivery_id = ${d.id})::int n`;
    const r = await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    expect(r.status).toBe(409);
    expect(r.body.error!.code).toBe('SHIFT_CLOSED');
    const after =
      await h.sql`select (select count(*) from public.delivery_events where delivery_id = ${d.id})::int e, (select count(*) from public.notifications where delivery_id = ${d.id})::int n`;
    expect(after).toEqual(before);
    expect(await h.sql`select 1 from public.assignments where delivery_id = ${d.id}`).toHaveLength(
      0,
    );
  });
});
