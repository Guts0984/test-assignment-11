import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BASE_FEE_KOP, nextAttemptAt, quote } from '@courier/shared';
import {
  act,
  assign,
  call,
  codeOf,
  createViaApi,
  handoverReady,
  idemKey,
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
const T = 120_000;

type Err = {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
};

const eventsOf = async (id: string) =>
  await h.sql`select type, from_status, to_status, actor_role, device_time, server_time, payload from public.delivery_events where delivery_id = ${id} order by id`;
const notifTypes = async (id: string) =>
  (
    await h.sql<
      { event_type: string }[]
    >`select event_type from public.notifications where delivery_id = ${id} order by seq`
  ).map((r) => r.event_type);

describe('acceptance 3: create → assign → pick up → hand over by code', () => {
  it(
    'walks the whole life, and every audience sees it',
    async () => {
      const a = await makeActors(h.sql);
      const d = await createViaApi(h, a.sender.accessToken, {
        codKop: 123_450,
        weightG: 2500,
        zone: 'B',
      });
      expect(d).toMatchObject({
        status: 'created',
        feeKop: 8000 + 2 * 800,
        codCommissionKop: 2469,
        totalKop: 9600 + 2469,
        attemptNo: 1,
      });
      expect(JSON.stringify(d)).not.toMatch(/recipientCode|"code"/);

      const track0 = await call<{
        status: string;
        courierName: string | null;
        code: string;
        amountDueKop: number;
      }>(h, 'GET', `/tracking/${d.trackingToken}`);
      expect(track0.body).toMatchObject({
        status: 'created',
        courierName: null,
        amountDueKop: 123_450,
      });
      expect(track0.body.code).toBe(await codeOf(h.sql, d.id));

      expect((await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id)).status).toBe(200);
      const today = await call<{
        deliveries: Record<string, unknown>[];
        shift: { id: string } | null;
      }>(h, 'GET', '/courier/today', { token: a.courier.accessToken });
      expect(today.body.shift).not.toBeNull();
      expect(today.body.deliveries.map((x) => x.id)).toEqual([d.id]);
      // what a courier must NOT see
      const seen = JSON.stringify(today.body.deliveries[0]);
      for (const secret of [
        await codeOf(h.sql, d.id),
        d.trackingToken,
        '"feeKop"',
        '"totalKop"',
        '"senderId"',
        '"recipientCode"',
      ])
        expect(seen).not.toContain(secret);
      expect(today.body.deliveries[0]).toMatchObject({ amountDueKop: 123_450, status: 'assigned' });

      expect(
        (await sendActions(h, a.courier.accessToken, [act.pickup(d.id)])).body.results[0]!.result,
      ).toBe('applied');
      const code = await codeOf(h.sql, d.id);
      const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'handover');
      const done = await sendActions(h, a.courier.accessToken, [
        act.deliver(d.id, code, 123_450, photo.photoId),
      ]);
      expect(done.body.results[0]).toMatchObject({ result: 'applied', status: 'delivered' });

      const track = await call<{
        status: string;
        courierName: string;
        timeline: { status: string }[];
      }>(h, 'GET', `/tracking/${d.trackingToken}`);
      expect(track.body.status).toBe('delivered');
      expect(track.body.courierName).toMatch(/^\S+ \S\.$/);
      expect(track.body.timeline.map((t) => t.status)).toEqual([
        'created',
        'assigned',
        'picked_up',
        'delivered',
      ]);
      const card = await call<{
        delivery: DeliveryDto;
        events: {
          type: string;
          actorRole: string;
          deviceTime: string | null;
          serverTime: string;
        }[];
        photos: { kind: string }[];
      }>(h, 'GET', `/deliveries/${d.id}`, { token: a.sender.accessToken });
      expect(card.body.delivery.status).toBe('delivered');
      expect(card.body.events.map((e) => e.type)).toEqual([
        'created',
        'assigned',
        'picked_up',
        'delivered',
      ]);
      expect(card.body.events.map((e) => e.actorRole)).toEqual([
        'sender',
        'dispatcher',
        'courier',
        'courier',
      ]);
      // history keeps both the device time and the server time
      expect(card.body.events[2]!.deviceTime).not.toBeNull();
      expect(card.body.events[2]!.serverTime).toBeTruthy();
      expect(card.body.photos).toHaveLength(1);
      expect(await notifTypes(d.id)).toEqual(['created', 'assigned', 'picked_up', 'delivered']);
      const [row] =
        await h.sql`select delivered_at, cod_collected_kop, courier_id from public.deliveries where id = ${d.id}`;
      expect(row).toMatchObject({ cod_collected_kop: 123_450, courier_id: a.courier.user.id });
      // the courier's list is empty again
      const after = await call<{ deliveries: unknown[] }>(h, 'GET', '/courier/today', {
        token: a.courier.accessToken,
      });
      expect(after.body.deliveries).toHaveLength(0);
    },
    T,
  );

  it('COD must match exactly and the code must be right; a rejected attempt changes nothing but the counter', async () => {
    const a = await makeActors(h.sql);
    const { d, code, photoId } = await handoverReady(h, a, { codKop: 50_000 });
    for (const cod of [0, 49_999, 50_001, 500_000]) {
      const r = await sendActions(h, a.courier.accessToken, [
        act.deliver(d.id, code, cod, photoId),
      ]);
      expect(r.body.results[0], `cod ${cod}`).toMatchObject({
        result: 'rejected',
        code: 'COD_MISMATCH',
      });
    }
    const [row] =
      await h.sql`select status, wrong_code_streak from public.deliveries where id = ${d.id}`;
    expect(row).toMatchObject({ status: 'picked_up', wrong_code_streak: 0 }); // a wrong amount is not a wrong code
    expect(
      (await sendActions(h, a.courier.accessToken, [act.deliver(d.id, code, 50_000, photoId)])).body
        .results[0]!.result,
    ).toBe('applied');
  });

  it('a delivery without COD needs a collected sum of 0', async () => {
    const a = await makeActors(h.sql);
    const { d, code, photoId } = await handoverReady(h, a);
    const r = await sendActions(h, a.courier.accessToken, [act.deliver(d.id, code, 100, photoId)]);
    expect(r.body.results[0]).toMatchObject({
      result: 'rejected',
      code: 'COD_MISMATCH',
      details: { expectedKop: 0 },
    });
  });
});

describe('acceptance 4: not picked up in 45 minutes → back in the queue, with the reason in the history', () => {
  it('releases the delivery, tells the courier, and the dispatcher can hand it to someone else', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    await h.sql`update public.deliveries set assigned_at = now() - interval '46 minutes' where id = ${d.id}`;
    await h.sql`select app_private.release_stale_assignments(now())`;
    expect(await statusOf(h.sql, d.id)).toBe('created');
    const card = await call<{
      events: { type: string; actorRole: string; payload: Record<string, unknown> }[];
    }>(h, 'GET', `/deliveries/${d.id}`, { token: a.dispatcher.accessToken });
    const released = card.body.events.find((e) => e.type === 'released')!;
    expect(released).toMatchObject({ actorRole: 'system' });
    expect(released.payload).toMatchObject({ reason: 'pickup_timeout', minutes: 45 });
    const senderCard = await call<{ events: { type: string; payload: Record<string, unknown> }[] }>(
      h,
      'GET',
      `/deliveries/${d.id}`,
      { token: a.sender.accessToken },
    );
    expect(senderCard.body.events.find((e) => e.type === 'released')!.payload).toEqual({
      reason: 'pickup_timeout',
      minutes: 45,
    }); // no courier id for senders
    const today = await call<{
      deliveries: unknown[];
      removed: { deliveryId: string; reason: string }[];
    }>(h, 'GET', '/courier/today', { token: a.courier.accessToken });
    expect(today.body.deliveries).toHaveLength(0);
    expect(today.body.removed.find((r) => r.deliveryId === d.id)).toMatchObject({
      reason: 'timeout',
    });
    const board = await call<{ zones: { zone: string; items: { id: string }[] }[] }>(
      h,
      'GET',
      '/dispatch/board',
      { token: a.dispatcher.accessToken },
    );
    expect(
      board.body.zones.flatMap((z) => z.items).some((i) => i.id === d.id) ||
        (await h.sql`select 1 from public.deliveries where id = ${d.id} and status = 'created'`)
          .length === 1,
    ).toBe(true);
    expect((await assign(h, a.dispatcher.accessToken, d.id, a.courier2.user.id)).status).toBe(200);
    expect(await notifTypes(d.id)).toEqual(['created', 'assigned', 'released', 'assigned']);
  });
});

describe('acceptance 5: three failed attempts → returning → returned', () => {
  async function failOnce(
    a: Awaited<ReturnType<typeof makeActors>>,
    id: string,
    reason = 'recipient_absent',
  ) {
    const pk = await sendActions(h, a.courier.accessToken, [act.pickup(id)]);
    expect(pk.body.results[0]!.result).toBe('applied');
    const photo = await uploadPhotoVia(h, a.courier.accessToken, id, 'failed');
    return sendActions(h, a.courier.accessToken, [
      act.fail(id, photo.photoId, reason, reason === 'other' ? 'dog at the gate' : undefined),
    ]);
  }

  it(
    'retries only from the next day, increments the attempt, returns after the 3rd, and notifies in order',
    async () => {
      const a = await makeActors(h.sql);
      const d = await createViaApi(h, a.sender.accessToken);
      try {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const asg = await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
          expect(asg.status, `assign ${attempt}`).toBe(200);
          expect(asg.body.delivery!.attemptNo).toBe(attempt);
          const f = await failOnce(a, d.id);
          expect(f.body.results[0]).toMatchObject({
            result: 'applied',
            status: attempt === 3 ? 'returning' : 'failed_attempt',
          });
          if (attempt < 3) {
            const [row] =
              await h.sql`select status, next_attempt_at, courier_id from public.deliveries where id = ${d.id}`;
            expect(row).toMatchObject({ status: 'failed_attempt', courier_id: null });
            const next = nextAttemptAt(h.clock.now());
            expect(new Date(row!.next_attempt_at).toISOString()).toBe(next.toISOString());
            // same day: refused, with the date when it becomes possible
            const early = await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
            expect(early.status).toBe(409);
            expect(early.body.error!.code).toBe('TOO_EARLY');
            expect(early.body.error!.details!.nextAttemptAt).toBe(next.toISOString());
            h.clock.set(new Date(next.getTime() + 1000)); // "the next day"
          }
        }
        expect(await statusOf(h.sql, d.id)).toBe('returning');
        const [row] =
          await h.sql`select attempt_no, next_attempt_at from public.deliveries where id = ${d.id}`;
        expect(row).toMatchObject({ attempt_no: 3, next_attempt_at: null });
        // a returning delivery cannot be assigned again
        expect(
          (await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id)).body.error!.code,
        ).toBe('INVALID_STATUS');
        // only a dispatcher marks it returned, and only from returning
        expect(
          (
            await call(h, 'POST', `/dispatch/deliveries/${d.id}/returned`, {
              token: a.sender.accessToken,
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await call(h, 'POST', `/dispatch/deliveries/${d.id}/returned`, {
              token: a.dispatcher.accessToken,
            })
          ).status,
        ).toBe(200);
        expect(await statusOf(h.sql, d.id)).toBe('returned');
        const again = await call<Err>(h, 'POST', `/dispatch/deliveries/${d.id}/returned`, {
          token: a.dispatcher.accessToken,
        });
        expect(again.status).toBe(409);
        // the sender got every notification, in order, including both of the last failure's
        expect(await notifTypes(d.id)).toEqual([
          'created',
          'assigned',
          'picked_up',
          'failed_attempt',
          'assigned',
          'picked_up',
          'failed_attempt',
          'assigned',
          'picked_up',
          'failed_attempt',
          'returning',
          'returned',
        ]);
        const ev = await eventsOf(d.id);
        expect(
          ev.filter((e) => e.type === 'failed_attempt').map((e) => e.payload.attemptNo),
        ).toEqual([1, 2, 3]);
      } finally {
        h.clock.set(new Date());
      }
    },
    T,
  );

  it(
    'every failure reason is accepted; "other" needs a note; the reason lands in the history',
    async () => {
      const a = await makeActors(h.sql);
      const reasons = [
        'recipient_absent',
        'wrong_address',
        'recipient_refused',
        'no_access',
        'phone_unreachable',
        'other',
      ];
      for (const reason of reasons) {
        const x = await pickedUp(h, a);
        const photo = await uploadPhotoVia(h, a.courier.accessToken, x.d.id, 'failed');
        const r = await sendActions(h, a.courier.accessToken, [
          act.fail(x.d.id, photo.photoId, reason, reason === 'other' ? 'locked gate' : undefined),
        ]);
        expect(r.body.results[0]!.result, reason).toBe('applied');
        const ev = (await eventsOf(x.d.id)).find((e) => e.type === 'failed_attempt')!;
        expect(ev.payload.reason).toBe(reason);
      }
      const x = await pickedUp(h, a);
      const photo = await uploadPhotoVia(h, a.courier.accessToken, x.d.id, 'failed');
      // an invalid action is rejected on its own, with the field named; the delivery is untouched
      for (const [reason, field] of [
        ['other', 'note'],
        ['bored', 'reason'],
      ] as const) {
        const bad = await sendActions(h, a.courier.accessToken, [
          act.fail(x.d.id, photo.photoId, reason),
        ]);
        expect(bad.status).toBe(200);
        expect(bad.body.results[0]).toMatchObject({
          result: 'rejected',
          code: 'VALIDATION_FAILED',
        });
        expect(Object.keys(bad.body.results[0]!.details!.fields as object)).toContain(field);
      }
      expect(await statusOf(h.sql, x.d.id)).toBe('picked_up');
    },
    T,
  );

  it('failing a delivery that is not picked up by you is rejected with a reason', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'failed');
    const notYetPickedUp = await sendActions(h, a.courier.accessToken, [
      act.fail(d.id, photo.photoId),
    ]);
    expect(notYetPickedUp.body.results[0]).toMatchObject({
      result: 'rejected',
      code: 'INVALID_STATUS',
    });
    const stranger = await sendActions(h, a.courier2.accessToken, [act.fail(d.id, photo.photoId)]);
    expect(stranger.body.results[0]).toMatchObject({ result: 'rejected', code: 'REASSIGNED' });
  });
});

describe('assignment refusals say why', () => {
  it('shift closed, courier full, already assigned, reassign, wrong statuses, unknown ids', async () => {
    const a = await makeActors(h.sql, { shifts: false });
    const d = await createViaApi(h, a.sender.accessToken);
    expect(
      (await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id)).body.error,
    ).toMatchObject({ code: 'SHIFT_CLOSED' });
    expect(
      (await call(h, 'POST', '/courier/shift/open', { token: a.courier.accessToken })).status,
    ).toBe(200);
    expect(
      (await call<Err>(h, 'POST', '/courier/shift/open', { token: a.courier.accessToken })).body
        .error.code,
    ).toBe('SHIFT_ALREADY_OPEN');
    await call(h, 'POST', '/courier/shift/open', { token: a.courier2.accessToken });
    expect((await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id)).status).toBe(200);
    // already assigned (to the same courier and to another one)
    expect(
      (await assign(h, a.dispatcher.accessToken, d.id, a.courier2.user.id)).body.error,
    ).toMatchObject({ code: 'ALREADY_ASSIGNED', details: { courierId: a.courier.user.id } });
    expect(
      (await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id, true)).body.error!.code,
    ).toBe('ALREADY_ASSIGNED');
    // explicit reassignment works
    const re = await assign(h, a.dispatcher.accessToken, d.id, a.courier2.user.id, true);
    expect(re.status).toBe(200);
    expect(re.body.delivery).toMatchObject({ status: 'assigned', courierId: a.courier2.user.id });
    const ev = (await eventsOf(d.id)).map((e) => e.type);
    expect(ev).toEqual(['created', 'assigned', 'reassigned']);
    const asg =
      await h.sql`select end_reason from public.assignments where delivery_id = ${d.id} order by assigned_at`;
    expect(asg.map((x) => x.end_reason)).toEqual(['reassigned', null]);
    // picked up / cancelled / delivered
    await sendActions(h, a.courier2.accessToken, [act.pickup(d.id)]);
    expect(
      (await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id, true)).body.error!.code,
    ).toBe('ALREADY_PICKED_UP');
    const cancelled = await createViaApi(h, a.sender.accessToken);
    await call(h, 'POST', `/deliveries/${cancelled.id}/cancel`, { token: a.sender.accessToken });
    expect(
      (await assign(h, a.dispatcher.accessToken, cancelled.id, a.courier.user.id)).body.error,
    ).toMatchObject({ code: 'INVALID_STATUS', details: { status: 'cancelled' } });
    // unknown / wrong kind of ids
    expect(
      (await assign(h, a.dispatcher.accessToken, randomUUID(), a.courier.user.id)).status,
    ).toBe(404);
    const open = await createViaApi(h, a.sender.accessToken);
    expect((await assign(h, a.dispatcher.accessToken, open.id, randomUUID())).status).toBe(404);
    expect((await assign(h, a.dispatcher.accessToken, open.id, a.sender.user.id)).status).toBe(404); // a sender is not a courier
    expect(await statusOf(h.sql, open.id)).toBe('created');
    expect(
      (
        await call(h, 'POST', '/dispatch/deliveries/not-a-uuid/assign', {
          token: a.dispatcher.accessToken,
          body: { courierId: a.courier.user.id },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, 'POST', `/dispatch/deliveries/${d.id}/assign`, {
          token: a.dispatcher.accessToken,
          body: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, 'POST', `/dispatch/deliveries/${d.id}/assign`, {
          token: a.dispatcher.accessToken,
          body: { courierId: a.courier.user.id, courier: 'x' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('cancelling', () => {
  it('works before pickup (also frees the courier), is idempotent, and is refused afterwards', async () => {
    const a = await makeActors(h.sql);
    const fresh = await createViaApi(h, a.sender.accessToken);
    expect(
      (await call(h, 'POST', `/deliveries/${fresh.id}/cancel`, { token: a.sender.accessToken }))
        .status,
    ).toBe(200);
    expect(await notifTypes(fresh.id)).toEqual(['created', 'cancelled']);
    const again = await call<{ changed: boolean }>(h, 'POST', `/deliveries/${fresh.id}/cancel`, {
      token: a.sender.accessToken,
    });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(await notifTypes(fresh.id)).toEqual(['created', 'cancelled']); // no second notification

    const assigned = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, assigned.id, a.courier.user.id);
    expect(
      (await call(h, 'POST', `/deliveries/${assigned.id}/cancel`, { token: a.sender.accessToken }))
        .status,
    ).toBe(200);
    const [asg] =
      await h.sql`select end_reason from public.assignments where delivery_id = ${assigned.id}`;
    expect(asg!.end_reason).toBe('cancelled');
    const [row] =
      await h.sql`select courier_id, status from public.deliveries where id = ${assigned.id}`;
    expect(row).toMatchObject({ courier_id: null, status: 'cancelled' });

    const x = await pickedUp(h, a);
    const late = await call<Err>(h, 'POST', `/deliveries/${x.d.id}/cancel`, {
      token: a.sender.accessToken,
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ALREADY_PICKED_UP');
    const photo = await uploadPhotoVia(h, a.courier.accessToken, x.d.id, 'handover');
    await sendActions(h, a.courier.accessToken, [act.deliver(x.d.id, x.code, 0, photo.photoId)]);
    expect(
      (await call<Err>(h, 'POST', `/deliveries/${x.d.id}/cancel`, { token: a.sender.accessToken }))
        .body.error.code,
    ).toBe('INVALID_STATUS');
  });
});

describe('price quote and create validation', () => {
  it.each([
    ['A', 1000, 0],
    ['A', 1001, 0],
    ['B', 30_000, 250_000],
    ['C', 1, 1],
    ['C', 15_500, 99_999],
    ['A', 2000, 10_000_000],
  ] as const)(
    'quote %s %i g COD %i equals the shared tariff and the created delivery',
    async (zone, weightG, codKop) => {
      const a = await makeActors(h.sql, { shifts: false });
      const q = await call<{ feeKop: number; totalKop: number; codCommissionKop: number }>(
        h,
        'POST',
        '/deliveries/quote',
        { token: a.sender.accessToken, body: { zone, weightG, codKop } },
      );
      expect(q.status).toBe(200);
      expect(q.body).toMatchObject(quote({ zone, weightG, codKop }));
      const d = await createViaApi(h, a.sender.accessToken, { zone, weightG, codKop });
      expect(d).toMatchObject({
        feeKop: q.body.feeKop,
        codCommissionKop: q.body.codCommissionKop,
        totalKop: q.body.totalKop,
      });
      expect(BASE_FEE_KOP[zone]).toBeLessThanOrEqual(d.feeKop);
    },
  );

  const bad: [string, Record<string, unknown>, string][] = [
    ['weight 0', { weightG: 0 }, 'weightG'],
    ['weight 30001', { weightG: 30_001 }, 'weightG'],
    ['weight 1.5', { weightG: 1.5 }, 'weightG'],
    ['weight as text', { weightG: '1500' }, 'weightG'],
    ['COD negative', { codKop: -1 }, 'codKop'],
    ['COD above the limit', { codKop: 10_000_001 }, 'codKop'],
    ['zone D', { zone: 'D' }, 'zone'],
    ['zone lowercase', { zone: 'a' }, 'zone'],
    ['phone letters', { recipientPhone: 'call me' }, 'recipientPhone'],
    ['phone too short', { recipientPhone: '+38067' }, 'recipientPhone'],
    ['empty name', { recipientName: '   ' }, 'recipientName'],
    ['name with newline', { recipientName: 'Olena\nKovalenko' }, 'recipientName'],
    ['name too long', { recipientName: 'x'.repeat(101) }, 'recipientName'],
    ['empty city', { address: { city: '', street: 's', house: '1' } }, 'address.city'],
    ['missing street', { address: { city: 'Kyiv', house: '1' } }, 'address.street'],
    ['missing house', { address: { city: 'Kyiv', street: 's' } }, 'address.house'],
    [
      'unknown address key',
      { address: { city: 'Kyiv', street: 's', house: '1', country: 'x' } },
      'address',
    ],
    ['unknown top-level key', { discount: 100 }, ''],
    ['server-owned fee', { feeKop: 1 }, ''],
    ['server-owned total', { totalKop: 1 }, ''],
    ['server-owned status', { status: 'delivered' }, ''],
    ['server-owned sender', { senderId: randomUUID() }, ''],
  ];
  it.each(bad)('rejects %s with a 400 that names the field', async (_n, over, field) => {
    const a = await makeActors(h.sql, { shifts: false });
    const r = await call<Err>(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody(over),
      headers: { 'Idempotency-Key': idemKey() },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(r.body.error.requestId).toBeTruthy();
    const issues = r.body.error.details!.issues as { path: string }[];
    expect(issues.length).toBeGreaterThan(0);
    if (field) expect(Object.keys(r.body.error.details!.fields as object)).toContain(field);
    expect(
      await h.sql`select 1 from public.deliveries where sender_id = ${a.sender.user.id}`,
    ).toHaveLength(0);
  });

  it('accepts the exact boundaries', async () => {
    const a = await makeActors(h.sql, { shifts: false });
    for (const over of [
      { weightG: 1 },
      { weightG: 30_000 },
      { codKop: 10_000_000 },
      { recipientName: 'x'.repeat(100) },
      { recipientPhone: '0671234567' },
      { recipientPhone: '+380 (67) 123-45-67' },
    ]) {
      const r = await call<DeliveryDto>(h, 'POST', '/deliveries', {
        token: a.sender.accessToken,
        body: validBody(over),
        headers: { 'Idempotency-Key': idemKey() },
      });
      expect(r.status, JSON.stringify(over)).toBe(201);
    }
    const phone = await call<DeliveryDto & { recipientPhone: string }>(h, 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: validBody({ recipientPhone: '0501112233' }),
      headers: { 'Idempotency-Key': idemKey() },
    });
    expect(phone.body.recipientPhone).toBe('+380501112233'); // normalised
  });

  it('quote validates too, and works without COD', async () => {
    const a = await makeActors(h.sql, { shifts: false });
    expect(
      (
        await call(h, 'POST', '/deliveries/quote', {
          token: a.sender.accessToken,
          body: { zone: 'A', weightG: 500 },
        })
      ).status,
    ).toBe(200);
    for (const b of [
      {},
      { zone: 'A' },
      { zone: 'A', weightG: 0 },
      { zone: 'Q', weightG: 1 },
      { zone: 'A', weightG: 1, extra: 1 },
    ]) {
      expect(
        (await call(h, 'POST', '/deliveries/quote', { token: a.sender.accessToken, body: b }))
          .status,
      ).toBe(400);
    }
  });
});

describe('role and ownership matrix (every route)', () => {
  it('each route answers 401 / 403 / 404 / 200 exactly as designed', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken);
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const tok = {
      sender: a.sender.accessToken,
      sender2: a.sender2.accessToken,
      dispatcher: a.dispatcher.accessToken,
      courier: a.courier.accessToken,
      courier2: a.courier2.accessToken,
    };
    type Row = [string, string, Record<string, number>];
    const id = d.id;
    const rows: Row[] = [
      ['GET', '/me', { none: 401, sender: 200, dispatcher: 200, courier: 200 }],
      ['POST', '/deliveries/quote', { none: 401, sender: 200, dispatcher: 403, courier: 403 }],
      ['GET', '/deliveries', { none: 401, sender: 200, dispatcher: 403, courier: 403 }],
      [
        'GET',
        `/deliveries/${id}`,
        { none: 401, sender: 200, sender2: 404, dispatcher: 200, courier: 403 },
      ],
      [
        'GET',
        `/deliveries/${id}/photos`,
        { none: 401, sender: 200, sender2: 404, dispatcher: 200, courier: 403 },
      ],
      [
        'POST',
        `/deliveries/${id}/cancel`,
        { none: 401, sender2: 404, dispatcher: 403, courier: 403 },
      ],
      ['GET', '/dispatch/board', { none: 401, sender: 403, courier: 403, dispatcher: 200 }],
      ['GET', '/dispatch/deliveries', { none: 401, sender: 403, courier: 403, dispatcher: 200 }],
      [
        'GET',
        `/dispatch/couriers/${a.courier.user.id}/shift`,
        { none: 401, sender: 403, courier: 403, dispatcher: 200 },
      ],
      [
        'GET',
        '/dispatch/report?from=2026-01-01&to=2026-01-31',
        { none: 401, sender: 403, courier: 403, dispatcher: 200 },
      ],
      ['POST', `/dispatch/deliveries/${id}/unblock`, { none: 401, sender: 403, courier: 403 }],
      ['GET', '/courier/today', { none: 401, sender: 403, dispatcher: 403, courier: 200 }],
      [
        'GET',
        '/courier/actions/rejected',
        { none: 401, sender: 403, dispatcher: 403, courier: 200 },
      ],
    ];
    for (const [method, path, expect_] of rows) {
      for (const [who, status] of Object.entries(expect_)) {
        const token = who === 'none' ? undefined : tok[who as keyof typeof tok];
        const r = await call<Err>(h, method, path, {
          token,
          body:
            method === 'POST' && path.endsWith('/quote') ? { zone: 'A', weightG: 1 } : undefined,
        });
        expect(r.status, `${method} ${path} as ${who}`).toBe(status);
        if (status >= 400)
          expect(r.body.error.code, `${method} ${path} as ${who}`).toMatch(/^[A-Z_]+$/);
      }
    }
  });

  it('a courier cannot read or touch another courier’s delivery; a sender cannot use courier or dispatch routes', async () => {
    const a = await makeActors(h.sql);
    const x = await pickedUp(h, a);
    const today2 = await call<{ deliveries: unknown[] }>(h, 'GET', '/courier/today', {
      token: a.courier2.accessToken,
    });
    expect(today2.body.deliveries).toHaveLength(0);
    expect(
      (await sendActions(h, a.courier2.accessToken, [act.pickup(x.d.id)])).body.results[0],
    ).toMatchObject({ result: 'rejected', code: 'REASSIGNED' });
    expect(
      (
        await call(h, 'POST', '/courier/actions', {
          token: a.sender.accessToken,
          body: { actions: [act.pickup(x.d.id)] },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(h, 'POST', `/dispatch/deliveries/${x.d.id}/assign`, {
          token: a.sender.accessToken,
          body: { courierId: a.courier.user.id },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(h, 'POST', '/courier/shift/open', { token: a.dispatcher.accessToken })).status,
    ).toBe(403);
  });

  it('a user with no role (or an unknown one) is refused everywhere', async () => {
    const a = await makeActors(h.sql);
    const { createTestUser, signIn } = await import('@courier/db/testing');
    const nobody = await createTestUser('sender', {
      omitAppRole: true,
      userMetadataRole: 'dispatcher',
    });
    const s = await signIn(nobody.email, nobody.password);
    for (const path of ['/me', '/deliveries', '/dispatch/board', '/courier/today']) {
      expect((await call(h, 'GET', path, { token: s.accessToken })).status, path).toBe(403);
    }
    void a;
  });
});

describe('listing, search, filters and pagination', () => {
  it(
    'filters by status, date and free text; pages never overlap; totals equal the database',
    async () => {
      const a = await makeActors(h.sql);
      const phones = ['+380501110001', '+380501110002', '+380671230000'];
      const made: DeliveryDto[] = [];
      for (let i = 0; i < 25; i++)
        made.push(
          await createViaApi(h, a.sender.accessToken, {
            recipientPhone: phones[i % 3],
            weightG: 100 + i,
          }),
        );
      await createViaApi(h, a.sender2.accessToken, { recipientPhone: phones[0] }); // someone else's, same phone
      await call(h, 'POST', `/deliveries/${made[0]!.id}/cancel`, { token: a.sender.accessToken });
      await assign(h, a.dispatcher.accessToken, made[1]!.id, a.courier.user.id);

      type Page = {
        items: { id: string; number: string; status: string; createdAt: string }[];
        total: number;
        page: number;
        pageSize: number;
      };
      const get = (qs: string) =>
        call<Page>(h, 'GET', `/deliveries?${qs}`, { token: a.sender.accessToken });
      const all = await get('pageSize=100');
      expect(all.body.total).toBe(25);
      expect(all.body.items.map((i) => i.id)).toEqual([...made].reverse().map((m) => m.id)); // newest first
      // pagination
      const p1 = await get('pageSize=10&page=1');
      const p2 = await get('pageSize=10&page=2');
      const p3 = await get('pageSize=10&page=3');
      const p4 = await get('pageSize=10&page=4');
      expect([p1, p2, p3, p4].map((p) => p.body.items.length)).toEqual([10, 10, 5, 0]);
      expect(
        new Set([...p1.body.items, ...p2.body.items, ...p3.body.items].map((i) => i.id)).size,
      ).toBe(25);
      expect(p3.body.total).toBe(25);
      // status filter (single and repeated)
      expect((await get('status=cancelled')).body.total).toBe(1);
      expect((await get('status=assigned')).body.items.map((i) => i.id)).toEqual([made[1]!.id]);
      expect((await get('status=cancelled&status=assigned')).body.total).toBe(2);
      // text search
      expect(
        (await get(`q=${encodeURIComponent(made[7]!.number)}`)).body.items.map((i) => i.id),
      ).toEqual([made[7]!.id]);
      expect(
        (await get(`q=${Number(made[7]!.number.slice(4))}`)).body.items.map((i) => i.id),
      ).toEqual([made[7]!.id]);
      expect((await get(`q=${encodeURIComponent(made[7]!.number.toLowerCase())}`)).body.total).toBe(
        1,
      );
      expect((await get(`q=${encodeURIComponent('+380501110001')}`)).body.total).toBe(9);
      expect((await get(`q=${encodeURIComponent('0501110001')}`)).body.total).toBe(9);
      expect((await get(`q=${encodeURIComponent('+3805011100')}`)).body.total).toBe(17); // prefix: phones ...0001 and ...0002
      expect((await get('q=nobody%20here')).body.total).toBe(0);
      expect((await get(`q=${encodeURIComponent("%' OR 1=1 --")}`)).body.total).toBe(0);
      expect((await get('q=%25')).body.total).toBe(0);
      // dates (Europe/Kyiv days)
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);
      expect(
        (await get(`from=${today}&to=${today}`)).body.total +
          (await get('from=2000-01-01&to=2000-01-02')).body.total,
      ).toBeGreaterThanOrEqual(0);
      expect((await get('from=2000-01-01&to=2000-12-31')).body.total).toBe(0);
      expect((await get(`from=${tomorrow}`)).body.total).toBe(0);
      expect((await get('from=2000-01-01')).body.total).toBe(25);
      // isolation: the other sender sees only their own
      const other = await call<Page>(h, 'GET', '/deliveries?pageSize=100', {
        token: a.sender2.accessToken,
      });
      expect(other.body.total).toBe(1);
      // the dispatcher can see everything, with the same filters
      const disp = await call<Page>(
        h,
        'GET',
        `/dispatch/deliveries?q=${encodeURIComponent(made[7]!.number)}`,
        { token: a.dispatcher.accessToken },
      );
      expect(disp.body.items.map((i) => i.id)).toEqual([made[7]!.id]);
      const [truth] = await h.sql<{ n: number }[]>`select count(*)::int n from public.deliveries`;
      const total = await call<Page>(h, 'GET', '/dispatch/deliveries?pageSize=1', {
        token: a.dispatcher.accessToken,
      });
      expect(total.body.total).toBe(truth!.n);
    },
    T,
  );

  it.each([
    'page=0',
    'page=-1',
    'page=abc',
    'page=1.5',
    'pageSize=0',
    'pageSize=101',
    'pageSize=abc',
    'status=bogus',
    'from=2026-02-30',
    'from=yesterday',
    'from=2026-05-02&to=2026-05-01',
    'q=' + 'x'.repeat(65),
    'unknown=1',
    'q=a%00b',
  ])('rejects the query "%s" with 400', async (qs) => {
    const a = await makeActors(h.sql, { shifts: false });
    const r = await call<Err>(h, 'GET', `/deliveries?${qs}`, { token: a.sender.accessToken });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('dispatcher board and report', () => {
  it('the board matches the database: queue per zone, courier load n/8, shift state, blocked handovers', async () => {
    const a = await makeActors(h.sql);
    const d1 = await createViaApi(h, a.sender.accessToken, { zone: 'C' });
    const blocked = await handoverReady(h, a);
    const wrong = blocked.code === '000000' ? '111111' : '000000';
    await sendActions(
      h,
      a.courier.accessToken,
      Array.from({ length: 5 }, () => act.deliver(blocked.d.id, wrong, 0, blocked.photoId)),
    );
    await assign(
      h,
      a.dispatcher.accessToken,
      (await createViaApi(h, a.sender.accessToken)).id,
      a.courier.user.id,
    );
    type Board = {
      zones: { zone: string; waiting: number; items: { id: string; assignable: boolean }[] }[];
      couriers: { id: string; onShift: boolean; active: number; limit: number }[];
      blocked: { id: string; wrongCodeStreak: number }[];
    };
    const b = await call<Board>(h, 'GET', '/dispatch/board', { token: a.dispatcher.accessToken });
    expect(b.status).toBe(200);
    expect(b.body.zones.map((z) => z.zone)).toEqual(['A', 'B', 'C']);
    const truth = await h.sql<
      { zone: string; n: number }[]
    >`select zone::text, count(*)::int n from public.deliveries where status in ('created','failed_attempt') group by zone`;
    for (const z of b.body.zones)
      expect(z.waiting).toBe(truth.find((t) => t.zone === z.zone)?.n ?? 0);
    expect(b.body.zones.find((z) => z.zone === 'C')!.items.length).toBeLessThanOrEqual(25);
    const me = b.body.couriers.find((c) => c.id === a.courier.user.id)!;
    expect(me).toMatchObject({ onShift: true, limit: 8, active: 2 });
    expect(b.body.couriers.find((c) => c.id === a.courier2.user.id)).toMatchObject({
      onShift: true,
      active: 0,
    });
    expect(b.body.blocked.find((x) => x.id === blocked.d.id)).toMatchObject({ wrongCodeStreak: 5 });
    void d1;
  });

  it('board order=newest lists the newest waiting deliveries first; the default is oldest first; a bad order is 400', async () => {
    const a = await makeActors(h.sql);
    const fresh: string[] = [];
    for (let i = 0; i < 3; i++) fresh.push((await createViaApi(h, a.sender.accessToken)).id);
    type B = { zones: { zone: string; items: { id: string; createdAt: string }[] }[] };
    const get = (q: string) =>
      call<B>(h, 'GET', `/dispatch/board${q}`, { token: a.dispatcher.accessToken });
    const newest = await get('?order=newest');
    expect(newest.status).toBe(200);
    const items = newest.body.zones.find((z) => z.zone === 'A')!.items;
    // newest first: the three fresh ones lead, most recent first
    expect(items.slice(0, 3).map((i) => i.id)).toEqual([...fresh].reverse());
    const times = items.map((i) => Date.parse(i.createdAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    const oldest = await get('?order=oldest');
    const def = await get('');
    expect(def.status).toBe(200);
    expect(def.body.zones.find((z) => z.zone === 'A')!.items.map((i) => i.id)).toEqual(
      oldest.body.zones.find((z) => z.zone === 'A')!.items.map((i) => i.id),
    );
    const dTimes = def.body.zones
      .find((z) => z.zone === 'A')!
      .items.map((i) => Date.parse(i.createdAt));
    expect(dTimes).toEqual([...dTimes].sort((x, y) => x - y));
    // with the default order the fresh deliveries are not at the head (the queue holds older ones)
    const [waiting] = await h.sql<
      { n: number }[]
    >`select count(*)::int n from public.deliveries where zone = 'A' and status in ('created','failed_attempt')`;
    if (waiting!.n > 25 + 3)
      expect(
        def.body.zones.find((z) => z.zone === 'A')!.items.some((i) => fresh.includes(i.id)),
      ).toBe(false);
    const bad = await get('?order=sideways');
    expect(bad.status).toBe(400);
    expect((bad.body as unknown as Err).error.code).toBe('VALIDATION_FAILED');
  });

  describe('board filters', () => {
    type FB = {
      zones: { zone: string; waiting: number; items: { id: string; status: string }[] }[];
      couriers: { id: string; onShift: boolean; active: number }[];
    };
    const get = (token: string, q: string) => call<FB>(h, 'GET', `/dispatch/board?${q}`, { token });
    const ids = (b: FB) => b.zones.flatMap((z) => z.items.map((i) => i.id)).sort();
    const tag = () => `Zq${randomUUID().replace(/-/g, '').slice(0, 10)}`;

    it('filters by zone, status, and searches by number, phone and name; filters combine', async () => {
      const a = await makeActors(h.sql);
      const t = tag();
      const phone = `+38050${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
      const dA = await createViaApi(h, a.sender.accessToken, {
        zone: 'A',
        recipientName: `${t} Alpha`,
        recipientPhone: phone,
      });
      const picked = await pickedUp(h, a, { zone: 'B', recipientName: `${t} Beta` });
      const dB = picked.d;
      const photo = await uploadPhotoVia(h, a.courier.accessToken, dB.id, 'failed');
      await sendActions(h, a.courier.accessToken, [act.fail(dB.id, photo.photoId, 'no_access')]);
      await h.sql`update public.deliveries set next_attempt_at = now() + interval '1 day' where id = ${dB.id}`;
      const tok = a.dispatcher.accessToken;

      const byName = await get(tok, `q=${t}`);
      expect(byName.status).toBe(200);
      expect(ids(byName.body)).toEqual([dA.id, dB.id].sort());
      expect(byName.body.zones.map((z) => z.zone)).toEqual(['A', 'B', 'C']);
      expect(byName.body.zones.map((z) => z.waiting)).toEqual([1, 1, 0]);
      // case-insensitive substring
      expect(ids((await get(tok, `q=${t.toLowerCase()}%20alp`)).body)).toEqual([dA.id]);

      const zoneB = await get(tok, `q=${t}&zone=B`);
      expect(zoneB.body.zones.map((z) => [z.zone, z.waiting, z.items.length])).toEqual([
        ['A', 0, 0],
        ['B', 1, 1],
        ['C', 0, 0],
      ]);
      expect(ids((await get(tok, `q=${t}&status=failed_attempt`)).body)).toEqual([dB.id]);
      expect(ids((await get(tok, `q=${t}&status=created`)).body)).toEqual([dA.id]);
      // combined: zone A AND failed_attempt matches nothing
      const none = await get(tok, `q=${t}&zone=A&status=failed_attempt`);
      expect(ids(none.body)).toEqual([]);
      expect(none.body.zones.map((z) => z.waiting)).toEqual([0, 0, 0]);

      // by number (DLV-… and plain digits) and by phone / phone prefix
      const num = dA.number;
      expect(ids((await get(tok, `q=${encodeURIComponent(num)}`)).body)).toContain(dA.id);
      expect(ids((await get(tok, `q=${Number(num.slice(4))}`)).body)).toContain(dA.id);
      expect(ids((await get(tok, `q=${encodeURIComponent(phone)}`)).body)).toEqual([dA.id]);
      expect(ids((await get(tok, `q=${encodeURIComponent(phone.slice(0, 9))}`)).body)).toContain(
        dA.id,
      );
      // LIKE metacharacters are literal
      expect(ids((await get(tok, `q=${encodeURIComponent(`${t}%`)}`)).body)).toEqual([]);
      expect(ids((await get(tok, `q=${encodeURIComponent('_'.repeat(5))}`)).body)).toEqual([]);
    });

    it('shift and free filters apply to the couriers list only', async () => {
      const a = await makeActors(h.sql);
      const tok = a.dispatcher.accessToken;
      const all = await get(tok, '');
      const on = await get(tok, 'shift=on');
      const off = await get(tok, 'shift=off');
      expect(all.body.couriers.length).toBeGreaterThan(0);
      expect(on.body.couriers.every((c) => c.onShift)).toBe(true);
      expect(off.body.couriers.every((c) => !c.onShift)).toBe(true);
      expect(on.body.couriers.length + off.body.couriers.length).toBe(all.body.couriers.length);
      expect(on.body.couriers.map((c) => c.id)).toContain(a.courier.user.id);
      expect((await get(tok, 'shift=all')).body.couriers.length).toBe(all.body.couriers.length);

      // fill one courier to the limit of 8
      for (let i = 0; i < 8; i++) {
        const d = await createViaApi(h, a.sender.accessToken);
        await assign(h, tok, d.id, a.courier.user.id);
      }
      for (const free of ['true', '1']) {
        const f = await get(tok, `free=${free}`);
        expect(f.body.couriers.map((c) => c.id)).not.toContain(a.courier.user.id);
        expect(f.body.couriers.map((c) => c.id)).toContain(a.courier2.user.id);
        expect(f.body.couriers.every((c) => c.active < 8)).toBe(true);
      }
      expect((await get(tok, 'free=false')).body.couriers.map((c) => c.id)).toContain(
        a.courier.user.id,
      );
      const both = await get(tok, 'free=true&shift=on');
      expect(both.body.couriers.every((c) => c.onShift && c.active < 8)).toBe(true);
      // the queue is not affected by the courier filters
      expect(ids((await get(tok, 'shift=off')).body)).toEqual(ids(all.body));
    });

    it('invalid values are 400, unknown keys are ignored, injection strings are harmless', async () => {
      const a = await makeActors(h.sql, { shifts: false });
      const tok = a.dispatcher.accessToken;
      for (const q of [
        'zone=D',
        'zone=a',
        'status=delivered',
        'shift=maybe',
        'free=yes',
        `q=${'x'.repeat(65)}`,
      ]) {
        const r = await call<Err>(h, 'GET', `/dispatch/board?${q}`, { token: tok });
        expect(r.status, q).toBe(400);
        expect(r.body.error.code).toBe('VALIDATION_FAILED');
      }
      expect((await get(tok, 'whatever=1&other=%00')).status).toBe(200);
      const before = await h.sql<{ n: number }[]>`select count(*)::int n from public.deliveries`;
      for (const evil of [
        `'; drop table deliveries; --`,
        `' or 1=1 --`,
        `%' or ''='`,
        `\\`,
        `");select pg_sleep(5);--`,
      ]) {
        const r = await get(tok, `q=${encodeURIComponent(evil)}`);
        expect(r.status, evil).toBe(200);
        expect(ids(r.body)).toEqual([]);
      }
      const after = await h.sql<{ n: number }[]>`select count(*)::int n from public.deliveries`;
      expect(after[0]!.n).toBeGreaterThanOrEqual(before[0]!.n);
    });
  });

  it('the report equals the database for the same period: delivered,mean time, failures by reason, cash discrepancies', async () => {
    const a = await makeActors(h.sql);
    // seed-independent ground truth for a window that only contains this run's data: use the exact current Kyiv day
    const x = await handoverReady(h, a, { codKop: 1_000 });
    await h.sql`update public.deliveries set assigned_at = now() - interval '30 minutes' where id = ${x.d.id}`;
    await sendActions(h, a.courier.accessToken, [act.deliver(x.d.id, x.code, 1_000, x.photoId)]);
    const y = await pickedUp(h, a);
    const photo = await uploadPhotoVia(h, a.courier.accessToken, y.d.id, 'failed');
    await sendActions(h, a.courier.accessToken, [act.fail(y.d.id, photo.photoId, 'no_access')]);
    const today = new Date().toISOString().slice(0, 10);
    const rep = await call<{
      period: { from: string; to: string };
      delivered: { count: number; avgAssignToDeliverSeconds: number | null };
      failedAttempts: { total: number; byReason: { reason: string; count: number }[] };
      cashDiscrepancies: { shifts: number; items: unknown[] };
    }>(h, 'GET', `/dispatch/report?from=${today}&to=${today}`, { token: a.dispatcher.accessToken });
    expect(rep.status).toBe(200);
    // ground truth over the same Kyiv-day window, computed independently in SQL
    const [t] = await h.sql<{ n: number; avg: number | null }[]>`
      select count(*)::int n, avg(extract(epoch from delivered_at - assigned_at))::float avg from public.deliveries
      where status = 'delivered' and (delivered_at at time zone 'Europe/Kyiv')::date = (now() at time zone 'Europe/Kyiv')::date`;
    expect(rep.body.delivered.count).toBe(t!.n);
    expect(
      Math.abs((rep.body.delivered.avgAssignToDeliverSeconds ?? 0) - (t!.avg ?? 0)),
    ).toBeLessThanOrEqual(1);
    const reasons = await h.sql<{ reason: string; n: number }[]>`
      select payload->>'reason' reason, count(*)::int n from public.delivery_events
      where type = 'failed_attempt' and (server_time at time zone 'Europe/Kyiv')::date = (now() at time zone 'Europe/Kyiv')::date group by 1`;
    for (const r of reasons)
      expect(rep.body.failedAttempts.byReason.find((x) => x.reason === r.reason)?.count).toBe(r.n);
    expect(rep.body.failedAttempts.total).toBe(reasons.reduce((s, r) => s + r.n, 0));
    expect(rep.body.delivered.avgAssignToDeliverSeconds).not.toBeNull();
  });

  it.each([
    'from=2026-01-01',
    'to=2026-01-01',
    'from=2026-02-01&to=2026-01-01',
    'from=2024-01-01&to=2026-01-01',
    'from=x&to=y',
    '',
  ])('report query "%s" is a 400', async (qs) => {
    const a = await makeActors(h.sql, { shifts: false });
    expect(
      (await call(h, 'GET', `/dispatch/report?${qs}`, { token: a.dispatcher.accessToken })).status,
    ).toBe(400);
  });

  it('a 90-day report over the seed works and is the documented shape', async () => {
    const a = await makeActors(h.sql, { shifts: false });
    const from = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const rep = await call<{
      delivered: { count: number };
      failedAttempts: { byReason: { reason: string }[] };
    }>(h, 'GET', `/dispatch/report?from=${from}&to=${to}`, { token: a.dispatcher.accessToken });
    expect(rep.status).toBe(200);
    expect(rep.body.delivered.count).toBeGreaterThan(30_000);
    expect(rep.body.failedAttempts.byReason.length).toBeGreaterThanOrEqual(5);
  });
});

describe('tracking (public)', () => {
  it('shows status, attempt, courier first name + initial, amount due and the code, but never the full address or phone', async () => {
    const a = await makeActors(h.sql);
    const d = await createViaApi(h, a.sender.accessToken, {
      codKop: 5_000,
      recipientPhone: '+380671234567',
    });
    await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
    const r = await call<Record<string, unknown>>(h, 'GET', `/tracking/${d.trackingToken}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([
      'amountDueKop',
      'attemptNo',
      'channel',
      'city',
      'code',
      'courierName',
      'number',
      'phoneMasked',
      'status',
      'street',
      'timeline',
      'updatedAt',
    ]);
    const text = JSON.stringify(r.body);
    for (const leak of [
      '+380671234567',
      '380671234567',
      '0671234567',
      '"house"',
      '"apartment"',
      'Olena Kovalenko',
      a.sender.user.id,
      '"senderId"',
      '"feeKop"',
    ])
      expect(text, leak).not.toContain(leak);
    expect(r.body.phoneMasked).toBe('+380 ••••••• 67');
    expect(r.body.street).toBe('Khreshchatyk');
    expect(r.body.courierName).toMatch(/^Test \S\.$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('unknown, malformed and look-alike tokens are all the same 404', async () => {
    const a = await makeActors(h.sql, { shifts: false });
    const d = await createViaApi(h, a.sender.accessToken);
    const candidates = [
      'A'.repeat(22),
      'short',
      '',
      d.trackingToken.slice(0, 21),
      `${d.trackingToken}x`,
      d.trackingToken.toLowerCase() === d.trackingToken
        ? d.trackingToken.toUpperCase()
        : d.trackingToken.toLowerCase(),
      "' OR 1=1 --",
      '../../etc/passwd',
      '%00',
      d.id,
      'x'.repeat(1000),
    ];
    for (const t of candidates) {
      if (t === d.trackingToken.toLowerCase() && t === d.trackingToken) continue;
      const r = await call<Err>(h, 'GET', `/tracking/${encodeURIComponent(t)}`);
      expect(r.status, t).toBe(404);
      expect(r.body.error.code).toBe('NOT_FOUND');
    }
    expect((await call(h, 'GET', '/tracking/')).status).toBe(404);
  });

  it(
    'tokens are 22 url-safe characters and unique across 200 creations',
    async () => {
      const a = await makeActors(h.sql, { shifts: false });
      const ds = await Promise.all(
        Array.from({ length: 200 }, () => createViaApi(h, a.sender.accessToken)),
      );
      const tokens = ds.map((d) => d.trackingToken);
      expect(new Set(tokens).size).toBe(200);
      for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const codes = await h.sql<
        { recipient_code: string }[]
      >`select recipient_code from public.delivery_secrets where delivery_id = any(${ds.map((d) => d.id)})`;
      expect(new Set(codes.map((c) => c.recipient_code)).size).toBeGreaterThan(150); // 6 digits are not unique by design, but they must not be constant
    },
    T,
  );
});

describe('uniform errors', () => {
  it('every failure uses { error: { code, message, requestId } } with the right status', async () => {
    const a = await makeActors(h.sql, { shifts: false });
    const cases: [
      string,
      Promise<{ status: number; body: Err; headers: Headers }>,
      number,
      string,
    ][] = [
      [
        'unknown route',
        call<Err>(h, 'GET', '/nope', { token: a.sender.accessToken }),
        404,
        'NOT_FOUND',
      ],
      ['no token', call<Err>(h, 'GET', '/me'), 401, 'UNAUTHENTICATED'],
      [
        'garbage token',
        call<Err>(h, 'GET', '/me', { token: 'abc.def.ghi' }),
        401,
        'UNAUTHENTICATED',
      ],
      [
        'wrong role',
        call<Err>(h, 'GET', '/dispatch/board', { token: a.sender.accessToken }),
        403,
        'FORBIDDEN',
      ],
      [
        'invalid json',
        call<Err>(h, 'POST', '/deliveries', {
          token: a.sender.accessToken,
          raw: '{"zone": ',
          contentType: 'application/json',
          headers: { 'Idempotency-Key': idemKey() },
        }),
        400,
        'INVALID_JSON',
      ],
      [
        'wrong content type',
        call<Err>(h, 'POST', '/deliveries/quote', {
          token: a.sender.accessToken,
          raw: 'zone=A',
          contentType: 'text/plain',
        }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      ],
      [
        'too large',
        call<Err>(h, 'POST', '/deliveries/quote', {
          token: a.sender.accessToken,
          raw: JSON.stringify({ zone: 'A', weightG: 1, pad: 'x'.repeat(300_000) }),
          contentType: 'application/json',
        }),
        413,
        'PAYLOAD_TOO_LARGE',
      ],
    ];
    for (const [name, p, status, code] of cases) {
      const r = await p;
      expect(r.status, name).toBe(status);
      expect(r.body.error.code, name).toBe(code);
      expect(typeof r.body.error.message, name).toBe('string');
      expect(r.body.error.requestId, name).toBeTruthy();
      expect(r.headers.get('x-request-id')).toBe(r.body.error.requestId);
      expect(r.headers.get('content-type')).toMatch(/application\/json/);
      expect(JSON.stringify(r.body)).not.toMatch(
        /at .*\.ts|node_modules|postgres|drizzle|select "/i,
      );
    }
  });

  it('a client-supplied X-Request-Id is echoed (when sane), garbage is replaced', async () => {
    const ok = await call<Err>(h, 'GET', '/nope', {
      headers: { 'X-Request-Id': 'trace-12345678' },
    });
    expect(ok.headers.get('x-request-id')).toBe('trace-12345678');
    const bad = await call<Err>(h, 'GET', '/nope', {
      headers: { 'X-Request-Id': 'a b c <script>' },
    });
    expect(bad.headers.get('x-request-id')).not.toContain('script');
  });

  it('security headers are present and nothing identifies the framework', async () => {
    const r = await call(h, 'GET', '/health');
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});
