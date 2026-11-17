import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { backoffSeconds } from '@courier/shared';
import { createStub, verifySignature, type RunningStub } from '../../sender-stub/src/stub';
import { signWebhook } from '../src/domain/webhook';
import { createProfiled } from '@courier/db/testing';
import { createWebhookWorker } from '../src/domain/ops/notifications';
import {
  act,
  assign,
  call,
  codeOf,
  createViaApi,
  handoverReady,
  idemKey,
  makeActors,
  sendActions,
  startHarness,
  uploadPhotoVia,
  useHarness,
  validBody,
  type Actors,
} from './harness';

const SECRET = 'whsec_test_secret_123';
const h = useHarness({
  env: { WEBHOOK_TIMEOUT_MS: '600', WEBHOOK_ALLOWED_PRIVATE_HOSTS: '127.0.0.1,localhost' },
  extra: { worker: { random: () => 0.5 } },
});
let stub: RunningStub;
beforeAll(async () => {
  // The worker tests assume they are the only worker on this database. A running `docker compose` API polls the same
  // notifications table and would take (and fail) the test notifications first.
  const other = await fetch(`http://127.0.0.1:${process.env.API_PORT ?? 4000}/health`, {
    signal: AbortSignal.timeout(1000),
  }).then(
    (r) => r.ok,
    () => false,
  );
  if (other)
    throw new Error(
      'Another API is running (docker compose?). Its webhook worker shares this database: run "docker compose stop api" before the webhook tests.',
    );
  stub = await createStub({ secret: SECRET });
});
afterAll(async () => {
  await stub.close();
  h.clock.set(new Date());
});
const T = 120_000;

async function newSender(): Promise<Actors> {
  const a = await makeActors(h.sql);
  const r = await call(h, 'PUT', '/webhook', {
    token: a.sender.accessToken,
    body: { url: `${stub.url}/hook`, secret: SECRET },
  });
  expect(r.status).toBe(200);
  return a;
}

const notes = async (deliveryId: string) =>
  h.sql<
    {
      id: string;
      seq: number;
      event_type: string;
      status: string;
      attempts: number;
      next_attempt_at: Date;
      last_error: string | null;
    }[]
  >`
    select id, seq, event_type, status, attempts, next_attempt_at, last_error from public.notifications where delivery_id = ${deliveryId} order by seq`;

const tickFor = (a: Actors) => h.api.worker.tick({ senderId: a.sender.user.id });

/** Ticks (advancing the fake clock when needed) until `done()` or the deadline. */
async function drain(a: Actors, done: () => boolean, stepMs = 0, max = 40): Promise<void> {
  for (let i = 0; i < max && !done(); i++) {
    await tickFor(a);
    if (stepMs) h.clock.advance(stepMs);
  }
}

async function fullLife(a: Actors, over: Record<string, unknown> = {}) {
  const x = await handoverReady(h, a, over);
  await sendActions(h, a.courier.accessToken, [act.deliver(x.d.id, x.code, x.d.codKop, x.photoId)]);
  return x;
}

const received = () => stub.state.received;
const mine = (deliveryId: string) =>
  received().filter((r) => (r.body as { deliveryId?: string })?.deliveryId === deliveryId);

describe('invariant 10: sender notifications', () => {
  it(
    'every notification is signed (HMAC), carries a permanent id, and arrives in order',
    async () => {
      const a = await newSender();
      const x = await fullLife(a);
      await drain(a, () => mine(x.d.id).length >= 4);
      const got = mine(x.d.id);
      expect(got.map((r) => (r.body as { event: string }).event)).toEqual([
        'created',
        'assigned',
        'picked_up',
        'delivered',
      ]);
      const db = await notes(x.d.id);
      expect(got.map((r) => r.webhookId)).toEqual(db.map((d) => d.id)); // the stored id IS the webhook id
      for (const r of got) {
        expect(r.signatureValid).toBe(true);
        expect(r.signature).toMatch(/^v1=[0-9a-f]{64}$/);
        // verified here with a third, independent implementation of the documented scheme
        const expected = `v1=${createHmac('sha256', SECRET).update(`${r.webhookId}.${r.timestamp}.${r.rawBody}`).digest('hex')}`;
        expect(r.signature).toBe(expected);
        expect(Number(r.timestamp)).toBeGreaterThan(1_700_000_000);
        expect((r.body as { id: string }).id).toBe(r.webhookId);
      }
      expect(db.every((d) => d.status === 'delivered' && d.attempts === 1)).toBe(true);
      // a wrong secret or a tampered body does not verify
      const r0 = got[0]!;
      expect(
        verifySignature('other-secret-value', r0.webhookId, r0.timestamp, r0.rawBody, r0.signature),
      ).toBe(false);
      expect(
        verifySignature(SECRET, r0.webhookId, r0.timestamp, r0.rawBody + ' ', r0.signature),
      ).toBe(false);
      expect(
        verifySignature(
          SECRET,
          r0.webhookId,
          String(Number(r0.timestamp) + 1),
          r0.rawBody,
          r0.signature,
        ),
      ).toBe(false);
      expect(signWebhook(SECRET, r0.webhookId, Number(r0.timestamp), r0.rawBody)).toBe(
        r0.signature,
      );
    },
    T,
  );

  it(
    '"delivered" never overtakes "picked_up": while an earlier notification fails, later ones are not even attempted',
    async () => {
      const a = await newSender();
      stub.state.mode = 'error';
      const x = await fullLife(a);
      await tickFor(a);
      await tickFor(a);
      const db = await notes(x.d.id);
      expect(db.map((d) => [d.seq, d.attempts, d.status])).toEqual([
        [1, 1, 'pending'],
        [2, 0, 'pending'],
        [3, 0, 'pending'],
        [4, 0, 'pending'],
      ]);
      expect(mine(x.d.id)).toHaveLength(1); // only "created" was tried (and failed)
      stub.state.mode = 'ok';
      h.clock.advance(31_000);
      await drain(a, () => mine(x.d.id).filter((r) => r.answered === 200).length >= 4, 1_000);
      const ok = mine(x.d.id).filter((r) => r.answered === 200);
      expect(ok.map((r) => (r.body as { event: string }).event)).toEqual([
        'created',
        'assigned',
        'picked_up',
        'delivered',
      ]);
      // arrival order == sequence order, for every attempt, failed or not
      const order = mine(x.d.id).map((r) => (r.body as { event: string }).event);
      const rank = ['created', 'assigned', 'picked_up', 'delivered'];
      expect(order.map((e) => rank.indexOf(e))).toEqual(
        [...order.map((e) => rank.indexOf(e))].sort((p, q) => p - q),
      );
      h.clock.set(new Date());
    },
    T,
  );

  it(
    'failures retry with growing pauses: 30 s, 60 s, 2 min … capped at exactly 24 h (acceptance 12 schedule)',
    async () => {
      const a = await newSender();
      stub.state.mode = 'error';
      const d = await createViaApi(h, a.sender.accessToken);
      const deltas: number[] = [];
      for (let i = 0; i < 16; i++) {
        const [before] = await notes(d.id);
        const now = h.clock.now().getTime();
        if (new Date(before!.next_attempt_at).getTime() > now)
          h.clock.set(new Date(new Date(before!.next_attempt_at).getTime() + 1));
        await tickFor(a);
        const [after] = await notes(d.id);
        deltas.push(
          Math.round((new Date(after!.next_attempt_at).getTime() - h.clock.now().getTime()) / 1000),
        );
        expect(after!.attempts).toBe(i + 1);
        expect(after!.last_error).toBe('HTTP 500');
      }
      const expected = Array.from({ length: 16 }, (_, i) => backoffSeconds(i + 1));
      expect(deltas).toEqual(expected);
      expect(deltas.slice(0, 5)).toEqual([30, 60, 120, 240, 480]);
      expect(Math.max(...deltas)).toBe(86_400);
      expect(deltas.slice(-3)).toEqual([86_400, 86_400, 86_400]);
      stub.state.mode = 'ok';
      h.clock.set(new Date());
    },
    T,
  );

  it(
    'a stub that does not answer is timed out, logged, and retried (acceptance 12: down 10 minutes, then up → all arrive in order)',
    async () => {
      const a = await newSender();
      stub.state.mode = 'hang';
      const x = await fullLife(a);
      const t0 = Date.now();
      await tickFor(a);
      expect(Date.now() - t0).toBeLessThan(5_000); // WEBHOOK_TIMEOUT_MS is 600 ms
      const [first] = await notes(x.d.id);
      expect(first).toMatchObject({ attempts: 1, last_error: 'timeout', status: 'pending' });
      // ten minutes of downtime, with the sender's server failing / hanging all the while
      for (let m = 0; m < 10; m++) {
        h.clock.advance(60_000);
        await tickFor(a);
      }
      expect((await notes(x.d.id)).every((d) => d.status === 'pending')).toBe(true);
      stub.state.mode = 'ok';
      await drain(a, () => mine(x.d.id).filter((r) => r.answered === 200).length >= 4, 130_000);
      const okRows = mine(x.d.id).filter((r) => r.answered === 200);
      expect(okRows.map((r) => (r.body as { event: string }).event)).toEqual([
        'created',
        'assigned',
        'picked_up',
        'delivered',
      ]);
      expect((await notes(x.d.id)).every((d) => d.status === 'delivered')).toBe(true);
      h.clock.set(new Date());
    },
    T,
  );

  it(
    'retries reuse the same Webhook-Id, so the receiver can de-duplicate',
    async () => {
      const a = await newSender();
      stub.state.mode = 'error';
      const d = await createViaApi(h, a.sender.accessToken);
      await tickFor(a);
      h.clock.advance(31_000);
      await tickFor(a);
      h.clock.advance(61_000);
      stub.state.mode = 'ok';
      await tickFor(a);
      const got = mine(d.id);
      expect(got).toHaveLength(3);
      expect(new Set(got.map((r) => r.webhookId)).size).toBe(1);
      expect(got.map((r) => r.answered)).toEqual([500, 500, 200]);
      const detail = await call<{
        attemptLog: { httpStatus: number | null; error: string | null; manual: boolean }[];
      }>(h, 'GET', `/notifications/${got[0]!.webhookId}`, { token: a.sender.accessToken });
      expect(detail.body.attemptLog.map((l) => l.httpStatus)).toEqual([500, 500, 200]);
      h.clock.set(new Date());
    },
    T,
  );

  it(
    'two workers ticking at the same moment never send the same notification twice',
    async () => {
      const a = await newSender();
      const ds = await Promise.all(
        Array.from({ length: 12 }, () => createViaApi(h, a.sender.accessToken)),
      );
      // a round takes at most 3 notifications per sender (fair share), so it takes a few rounds, each run by 4 workers at once
      for (let i = 0; i < 6; i++)
        await Promise.all([tickFor(a), tickFor(a), tickFor(a), tickFor(a)]);
      for (const d of ds) expect(mine(d.id), d.id).toHaveLength(1);
      const rows =
        await h.sql`select attempts from public.notifications where delivery_id = any(${ds.map((d) => d.id)})`;
      expect(rows.every((r) => r.attempts === 1)).toBe(true);
    },
    T,
  );

  it(
    'three failed attempts: the sender receives every notification, in order, including returning and returned (acceptance 5)',
    async () => {
      const a = await newSender();
      const d = await createViaApi(h, a.sender.accessToken);
      try {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
          await sendActions(h, a.courier.accessToken, [act.pickup(d.id)]);
          const photo = await uploadPhotoVia(h, a.courier.accessToken, d.id, 'failed');
          await sendActions(h, a.courier.accessToken, [act.fail(d.id, photo.photoId)]);
          if (attempt < 3) {
            const [row] =
              await h.sql`select next_attempt_at from public.deliveries where id = ${d.id}`;
            h.clock.set(new Date(new Date(row!.next_attempt_at).getTime() + 1000));
          }
        }
        await call(h, 'POST', `/dispatch/deliveries/${d.id}/returned`, {
          token: a.dispatcher.accessToken,
        });
        await drain(a, () => mine(d.id).length >= 12);
        expect(mine(d.id).map((r) => (r.body as { event: string }).event)).toEqual([
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
        expect(mine(d.id).every((r) => r.signatureValid)).toBe(true);
        expect(mine(d.id).map((r) => (r.body as { attemptNo: number }).attemptNo)).toEqual([
          1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 3,
        ]);
      } finally {
        h.clock.set(new Date());
      }
    },
    T,
  );
});

describe('notification log and manual resend', () => {
  it(
    'lists the sender’s own notifications with filters; other senders see none of them',
    async () => {
      const a = await newSender();
      const x = await fullLife(a);
      await drain(a, () => mine(x.d.id).length >= 4);
      type Page = {
        items: { id: string; status: string; number: string; eventType: string }[];
        total: number;
      };
      const all = await call<Page>(h, 'GET', '/notifications?pageSize=100', {
        token: a.sender.accessToken,
      });
      expect(all.body.total).toBe(4);
      expect(all.body.items.map((i) => i.eventType).sort()).toEqual([
        'assigned',
        'created',
        'delivered',
        'picked_up',
      ]);
      expect(all.body.items.every((i) => i.number === x.d.number)).toBe(true);
      expect(
        (
          await call<Page>(h, 'GET', '/notifications?status=pending', {
            token: a.sender.accessToken,
          })
        ).body.total,
      ).toBe(0);
      expect(
        (
          await call<Page>(h, 'GET', `/notifications?deliveryId=${x.d.id}&pageSize=2&page=2`, {
            token: a.sender.accessToken,
          })
        ).body.items,
      ).toHaveLength(2);
      expect(
        (await call<Page>(h, 'GET', '/notifications', { token: a.sender2.accessToken })).body.total,
      ).toBe(0);
      const one = all.body.items[0]!.id;
      expect(
        (await call(h, 'GET', `/notifications/${one}`, { token: a.sender2.accessToken })).status,
      ).toBe(404);
      expect(
        (await call(h, 'GET', `/notifications/${one}`, { token: a.courier.accessToken })).status,
      ).toBe(403);
      expect(
        (await call(h, 'GET', '/notifications?status=bogus', { token: a.sender.accessToken }))
          .status,
      ).toBe(400);
    },
    T,
  );

  it(
    'a sender can resend any notification; it keeps its id, is logged as manual, and others cannot resend it',
    async () => {
      const a = await newSender();
      const x = await fullLife(a);
      await drain(a, () => mine(x.d.id).length >= 4);
      const target = (await notes(x.d.id))[1]!;
      const before = mine(x.d.id).length;
      const r = await call<{
        notification: { id: string; status: string };
        attempt: { ok: boolean; httpStatus: number };
      }>(h, 'POST', `/notifications/${target.id}/resend`, { token: a.sender.accessToken });
      expect(r.status).toBe(200);
      expect(r.body.attempt).toMatchObject({ ok: true, httpStatus: 200 });
      expect(mine(x.d.id)).toHaveLength(before + 1);
      expect(mine(x.d.id).at(-1)!.webhookId).toBe(target.id);
      const detail = await call<{
        attemptLog: { manual: boolean }[];
        attempts: number;
        status: string;
      }>(h, 'GET', `/notifications/${target.id}`, { token: a.sender.accessToken });
      expect(detail.body.attemptLog.map((l) => l.manual)).toEqual([false, true]);
      expect(detail.body.status).toBe('delivered');
      expect(
        (
          await call(h, 'POST', `/notifications/${target.id}/resend`, {
            token: a.sender2.accessToken,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call(h, 'POST', `/notifications/${randomUUID()}/resend`, {
            token: a.sender.accessToken,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call(h, 'POST', `/notifications/${target.id}/resend`, {
            token: a.courier.accessToken,
          })
        ).status,
      ).toBe(403);
    },
    T,
  );

  it(
    'a pending notification can only be resent when it is the head of its queue (ordering cannot be bypassed)',
    async () => {
      const a = await newSender();
      stub.state.mode = 'error';
      const d = await createViaApi(h, a.sender.accessToken);
      await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
      const [first, second] = await notes(d.id);
      const before = mine(d.id).length;
      // #2 ("assigned") while #1 ("created") is still pending: refused, and nothing is sent to the receiver
      const blocked = await call<{ error: { code: string } }>(
        h,
        'POST',
        `/notifications/${second!.id}/resend`,
        { token: a.sender.accessToken },
      );
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CONFLICT');
      expect(mine(d.id)).toHaveLength(before);
      // #1 is the head: resending it is fine, also while the receiver fails
      const r = await call<{ attempt: { ok: boolean; httpStatus: number } }>(
        h,
        'POST',
        `/notifications/${first!.id}/resend`,
        { token: a.sender.accessToken },
      );
      expect(r.body.attempt).toMatchObject({ ok: false, httpStatus: 500 });
      stub.state.mode = 'ok';
      const ok = await call<{ notification: { status: string } }>(
        h,
        'POST',
        `/notifications/${first!.id}/resend`,
        { token: a.sender.accessToken },
      );
      expect(ok.body.notification.status).toBe('delivered');
      // now #2 is the head
      const next = await call<{ notification: { status: string } }>(
        h,
        'POST',
        `/notifications/${second!.id}/resend`,
        { token: a.sender.accessToken },
      );
      expect(next.status).toBe(200);
      expect(next.body.notification.status).toBe('delivered');
      expect(mine(d.id).map((x) => (x.body as { event: string }).event)).toEqual([
        'created',
        'created',
        'assigned',
      ]); // 500, then 200, then #2
    },
    T,
  );

  it(
    'a dead receiver for one sender does not delay another sender, and never holds a database connection',
    async () => {
      const dead = await newSender();
      const healthy = await newSender();
      const blackHole = await createStub({ secret: SECRET });
      blackHole.state.mode = 'hang'; // accepts the request and never answers: each attempt lasts the full 600 ms timeout
      try {
        await h.sql`update public.sender_webhooks set url = ${`${blackHole.url}/hook`} where sender_id = ${dead.sender.user.id}`;
        for (let i = 0; i < 24; i++) await createViaApi(h, dead.sender.accessToken); // 24 due notifications of the dead sender
        const d = await createViaApi(h, healthy.sender.accessToken);
        stub.state.mode = 'ok';

        const idle: number[] = [];
        const poll = setInterval(async () => {
          const [r] = await h.sql<
            { n: number }[]
          >`select count(*)::int n from pg_stat_activity where state = 'idle in transaction' and now() - state_change > interval '250 ms' and datname = current_database()`;
          idle.push(r!.n);
        }, 50);
        const started = performance.now();
        // the tick runs in the background (24 hung calls, 2 at a time, take several seconds); the healthy sender must not wait for it
        const tick = h.api.worker.tick({
          senderIds: [dead.sender.user.id, healthy.sender.user.id],
        });
        let status = 'pending';
        while (status !== 'delivered' && performance.now() - started < 15_000) {
          status = (await notes(d.id))[0]?.status ?? status;
          if (status !== 'delivered') await new Promise((r) => setTimeout(r, 25));
        }
        const elapsed = performance.now() - started;
        expect(status, 'the healthy sender is served').toBe('delivered');
        expect(elapsed, 'within about one request time, not behind the dead sender').toBeLessThan(
          2000,
        );
        const r = await tick;
        clearInterval(poll);
        expect(r.attempted).toBeGreaterThanOrEqual(25); // everything due was attempted
        expect(
          Math.max(0, ...idle),
          'no connection waits "idle in transaction" for the receiver',
        ).toBe(0);
      } finally {
        await blackHole.close();
      }
    },
    T,
  );

  it(
    'a dead sender never has more than 2 requests in flight at its receiver',
    async () => {
      const dead = await newSender();
      const blackHole = await createStub({ secret: SECRET });
      blackHole.state.mode = 'hang';
      let open = 0;
      let peak = 0;
      blackHole.server.on('request', (req, res) => {
        open++;
        peak = Math.max(peak, open);
        let done = false;
        const end = () => {
          if (!done) {
            done = true;
            open--;
          }
        };
        res.on('close', end);
      });
      try {
        await h.sql`update public.sender_webhooks set url = ${`${blackHole.url}/hook`} where sender_id = ${dead.sender.user.id}`;
        for (let i = 0; i < 8; i++) await createViaApi(h, dead.sender.accessToken);
        const r = await h.api.worker.tick({ senderId: dead.sender.user.id });
        expect(r.attempted).toBe(8);
        expect(peak, 'the cap is reached but never exceeded').toBe(2);
      } finally {
        await blackHole.close();
      }
    },
    T,
  );

  it(
    'one healthy sender with a big backlog drains at >= 30 notifications per second, in order per delivery',
    async () => {
      const a = await newSender();
      stub.state.mode = 'ok';
      const ids: string[] = [];
      for (let i = 0; i < 60; i++) ids.push((await createViaApi(h, a.sender.accessToken)).id);
      for (const id of ids.slice(0, 8))
        await assign(h, a.dispatcher.accessToken, id, a.courier.user.id);
      const [{ c } = { c: -1 }] = await h.sql<
        { c: number }[]
      >`select count(*)::int c from public.notifications where sender_id = ${a.sender.user.id} and status = 'pending'`;
      expect(c).toBe(68);
      const started = performance.now();
      await h.api.worker.tick({ senderId: a.sender.user.id });
      const elapsed = performance.now() - started;
      const [{ left } = { left: -1 }] = await h.sql<
        { left: number }[]
      >`select count(*)::int left from public.notifications where sender_id = ${a.sender.user.id} and status = 'pending'`;
      expect(left).toBe(0);
      expect(elapsed, `68 notifications in ${Math.round(elapsed)} ms`).toBeLessThan(6000);
      for (const id of ids.slice(0, 8))
        expect(mine(id).map((x) => (x.body as { event: string }).event)).toEqual([
          'created',
          'assigned',
        ]);
      for (const id of ids) expect(mine(id).length).toBeGreaterThanOrEqual(1);
    },
    T,
  );
});

describe('webhook settings and the SSRF guard', () => {
  it('stores URL and secret for the sender only', async () => {
    const a = await makeActors(h.sql, { shifts: false });
    const fresh = await createProfiled(h.sql, 'sender', { webhook: false });
    const freshSession = await (
      await import('@courier/db/testing')
    ).signIn(fresh.email, fresh.password);
    const none = await call<{ url: string | null }>(h, 'GET', '/webhook', {
      token: freshSession.accessToken,
    });
    expect(none.body.url).toBeNull();
    const set = await call<{ url: string; secret: string }>(h, 'PUT', '/webhook', {
      token: freshSession.accessToken,
      body: { url: `${stub.url}/hook`, secret: 'a-secret-123' },
    });
    expect(set.body).toMatchObject({ url: `${stub.url}/hook`, secret: 'a-secret-123' });
    const keep = await call<{ secret: string }>(h, 'PUT', '/webhook', {
      token: freshSession.accessToken,
      body: { url: `${stub.url}/other` },
    });
    expect(keep.body.secret).toBe('a-secret-123'); // omitted secret is kept
    expect(
      (await call<{ url: string }>(h, 'GET', '/webhook', { token: a.sender2.accessToken })).body
        .url,
    ).toBe('http://localhost:5000/hook'); // their own, not the other sender's
    expect(
      (
        await call(h, 'PUT', '/webhook', {
          token: a.courier.accessToken,
          body: { url: `${stub.url}/hook`, secret: 'a-secret-123' },
        })
      ).status,
    ).toBe(403);
    await h.sql`delete from public.sender_webhooks where sender_id = ${a.sender2.user.id}`;
    const first = await call(h, 'PUT', '/webhook', {
      token: a.sender2.accessToken,
      body: { url: `${stub.url}/hook` },
    });
    expect(first.status).toBe(400); // a secret is required the first time
  });

  it.each([
    ['AWS metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['private 10.x', 'http://10.0.0.5/hook'],
    ['private 192.168.x', 'http://192.168.1.1/hook'],
    ['private 172.16.x', 'http://172.16.0.1/hook'],
    ['unspecified', 'http://0.0.0.0/hook'],
    ['IPv6 loopback', 'http://[::1]/hook'],
    ['IPv6 unique local', 'http://[fd00::1]/hook'],
    ['IPv4-mapped IPv6', 'http://[::ffff:10.0.0.1]/hook'],
    ['.internal name', 'http://db.internal/hook'],
    ['.local name', 'http://printer.local/hook'],
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://example.com/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['credentials in URL', 'http://user:pass@example.com/hook'],
    ['not a URL', 'example.com/hook'],
    ['empty', ''],
  ])('rejects %s with a 400 on the url field', async (_n, url) => {
    const a = await makeActors(h.sql, { shifts: false });
    const r = await call<{ error: { details: { fields: Record<string, string> } } }>(
      h,
      'PUT',
      '/webhook',
      { token: a.sender.accessToken, body: { url, secret: 'a-secret-123' } },
    );
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.error.details.fields)).toContain('url');
  });

  it('a hostname that RESOLVES to a private address is blocked at save time and at send time', async () => {
    const a = await makeActors(h.sql);
    const worker = createWebhookWorker({
      ctx: h.api.ctx,
      resolve: async (host: string) =>
        host === 'rebind.example' ? ['10.1.2.3'] : ['93.184.216.34'],
    });
    await expect(worker.assertSafe('http://rebind.example/hook')).rejects.toThrow(
      /private address/,
    );
    await expect(worker.assertSafe('http://public.example/hook')).resolves.toBeUndefined();
    await expect(
      createWebhookWorker({
        ctx: h.api.ctx,
        resolve: async () => ['93.184.216.34', '127.0.0.1'],
      }).assertSafe('http://mixed.example/'),
    ).rejects.toThrow();
    await expect(
      createWebhookWorker({
        ctx: h.api.ctx,
        resolve: async () => {
          throw new Error('nx');
        },
      }).assertSafe('http://nx.example/'),
    ).rejects.toThrow(/resolve/);
    // an already-stored bad URL (e.g. saved before the rule existed) is refused when sending, and the failure is visible
    await h.sql`update public.sender_webhooks set url = 'http://169.254.169.254/latest' where sender_id = ${a.sender.user.id}`;
    const d = await createViaApi(h, a.sender.accessToken);
    await h.api.worker.tick({ senderId: a.sender.user.id });
    const [n] = await notes(d.id);
    expect(n).toMatchObject({ attempts: 1, status: 'pending' });
    expect(n!.last_error).toMatch(/blocked/);
  });

  it('redirects are not followed (a 302 to an internal address is just a failure)', async () => {
    const a = await makeActors(h.sql);
    let hits = 0;
    const redirectTo = createStubRedirect(() => hits++);
    const srv = await redirectTo;
    try {
      await h.sql`update public.sender_webhooks set url = ${srv.url + '/hook'} where sender_id = ${a.sender.user.id}`;
      const d = await createViaApi(h, a.sender.accessToken);
      await h.api.worker.tick({ senderId: a.sender.user.id });
      const [n] = await notes(d.id);
      expect(n!.last_error).toBe('HTTP 302');
      expect(hits).toBe(1);
      expect(
        received().filter((r) => (r.body as { deliveryId?: string })?.deliveryId === d.id),
      ).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });
});

async function createStubRedirect(onHit: () => void) {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    onHit();
    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

describe('the background loop', () => {
  it(
    'delivers by itself when the worker is enabled (no manual tick)',
    async () => {
      await h.sql`update public.notifications set next_attempt_at = now() + interval '30 days' where status = 'pending'`; // park leftovers of earlier tests
      const hh = await startHarness({
        env: {
          WEBHOOK_WORKER_ENABLED: 'true',
          WEBHOOK_POLL_INTERVAL_MS: '100',
          WEBHOOK_ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
        },
      });
      try {
        const a = await makeActors(hh.sql, { shifts: false });
        await call(hh, 'PUT', '/webhook', {
          token: a.sender.accessToken,
          body: { url: `${stub.url}/hook`, secret: SECRET },
        });
        const r = await call<{ id: string }>(hh, 'POST', '/deliveries', {
          token: a.sender.accessToken,
          body: validBody(),
          headers: { 'Idempotency-Key': idemKey() },
        });
        for (let i = 0; i < 50 && mine(r.body.id).length === 0; i++)
          await new Promise((x) => setTimeout(x, 100));
        expect(mine(r.body.id)).toHaveLength(1);
        expect(mine(r.body.id)[0]!.signatureValid).toBe(true);
      } finally {
        await hh.api.close();
        await hh.sql.end({ timeout: 2 });
      }
    },
    T,
  );

  it(
    'codeOf is not exposed through notifications (payloads carry no secrets)',
    async () => {
      const a = await newSender();
      const x = await fullLife(a);
      await drain(a, () => mine(x.d.id).length >= 4);
      const text = JSON.stringify(mine(x.d.id).map((r) => r.body));
      expect(text).not.toContain(await codeOf(h.sql, x.d.id));
      expect(text).not.toContain(x.d.trackingToken);
      expect(text).not.toContain('+380671234567');
      expect(text).not.toContain('Khreshchatyk');
    },
    T,
  );
});
