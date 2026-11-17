import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { useDb } from './db';
import { buildWorld, type World } from './world';
import { anonClient } from '../src/testing/users';
import { assignDelivery, createDelivery, pickUpDelivery, sleep } from '../src/testing/fixtures';

const { sql } = useDb(10);
let w: World;

beforeAll(async () => {
  w = await buildWorld(sql);
  // Warm-up: right after `supabase start/db reset` the replication pipeline can take a few seconds to go live.
  // Wait until a real change travels all the way to a subscriber before any assertion relies on silence.
  const probe = await listen(w.sessions.dispatcher, ['deliveries']);
  const deadline = Date.now() + 60_000;
  while (!probe.some((p) => p.new.id === w.deliveries.dA2.id) && Date.now() < deadline) {
    await sql`update public.deliveries set next_attempt_at = now() where id = ${w.deliveries.dA2.id}`;
    await sleep(1500);
  }
  expect(probe.length).toBeGreaterThan(0);
}, 180_000);

type Change = {
  table: string;
  eventType: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

const channels: { client: SupabaseClient; name: string }[] = [];

const subscriptionCount = async (identity: string | null): Promise<number> => {
  const [r] = identity
    ? await sql<
        { n: number }[]
      >`select count(*)::int n from realtime.subscription where claims->>'sub' = ${identity}`
    : await sql<
        { n: number }[]
      >`select count(*)::int n from realtime.subscription where claims->>'role' = 'anon'`;
  return r!.n;
};

/**
 * Subscribes to postgres_changes on the given tables and resolves once the server confirms SUBSCRIBED
 * AND has registered the subscriptions (events fired before that point would be missed, which would make
 * "nobody received anything" meaningless).
 */
async function listen(
  session: { accessToken: string; userId: string } | null,
  tables: string[],
): Promise<Change[]> {
  // A fresh client per subscription: supabase-js joins a client's 2nd+ channels with the anon key instead of
  // the user token (found by this very test), which would silently turn "courier B" into "anon".
  const client = session ? anonClient(session.accessToken) : anonClient();
  if (session) await client.realtime.setAuth(session.accessToken);
  const identity = session ? session.userId : null;
  const received: Change[] = [];
  const before = await subscriptionCount(identity);
  const name = `rt-${randomUUID()}`;
  let ch = client.channel(name);
  for (const table of tables) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, (p) =>
      received.push({
        table,
        eventType: p.eventType,
        new: p.new as Record<string, unknown>,
        old: p.old as Record<string, unknown>,
      }),
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('realtime subscribe timeout')), 15_000);
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        resolve();
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer);
        reject(new Error(`subscribe ${status}: ${err?.message ?? ''}`));
      }
    });
  });
  channels.push({ client, name });
  const deadline = Date.now() + 15_000;
  while ((await subscriptionCount(identity)) < before + tables.length && Date.now() < deadline)
    await sleep(100);
  await sleep(500);
  return received;
}

afterAll(async () => {
  for (const { client } of channels) await client.removeAllChannels().catch(() => undefined);
});

async function waitFor(pred: () => boolean, ms = 12_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

describe('Realtime postgres_changes honours RLS (invariant 12, acceptance 16)', () => {
  it('delivers a delivery change only to the sender, the assigned courier and dispatchers', async () => {
    const tables = ['deliveries'];
    const sA = await listen(w.sessions.senderA, tables);
    const sB = await listen(w.sessions.senderB, tables);
    const cA = await listen(w.sessions.courierA, tables);
    const cB = await listen(w.sessions.courierB, tables);
    const disp = await listen(w.sessions.dispatcher, tables);
    const sneaky = await listen(w.sessions.sneaky, tables);
    const anon = await listen(null, tables);

    const marker = new Date(Date.now() + 86_400_000).toISOString();
    await sql`update public.deliveries set next_attempt_at = ${marker} where id = ${w.deliveries.dA1.id}`;

    const mine = (rows: Change[]) => rows.filter((r) => r.new.id === w.deliveries.dA1.id);
    const withData = (rows: Change[]) =>
      rows.filter(
        (r) => Object.keys(r.new ?? {}).length > 0 || Object.keys(r.old ?? {}).length > 0,
      );
    // positive controls: the entitled parties DO get it, so the silence below means something
    expect(
      await waitFor(() => mine(sA).length > 0 && mine(cA).length > 0 && mine(disp).length > 0),
    ).toBe(true);
    await sleep(3000); // give a leak every chance to show up
    // users who hold the table privilege but fail the policy get no event at all
    expect(sB).toHaveLength(0);
    expect(cB).toHaveLength(0);
    expect(sneaky).toHaveLength(0);
    // anon holds no privilege: Realtime may send an error stub, which must carry no data
    expect(withData(anon)).toHaveLength(0);
    for (const stub of anon) expect(JSON.stringify(stub)).not.toContain(w.deliveries.dA1.id);
    // and nothing about B's delivery reached A's people either
    for (const rows of [sA, cA])
      expect(rows.filter((r) => r.new.id === w.deliveries.dB1.id)).toHaveLength(0);
  });

  it('a courier only hears about their own assignment ending (second courier sees the removal)', async () => {
    const cA = await listen(w.sessions.courierA, ['assignments']);
    const cB = await listen(w.sessions.courierB, ['assignments']);
    await sql`update public.assignments set ended_at = now(), end_reason = 'delivered_by_other'
      where delivery_id = ${w.deliveries.dA1.id} and ended_at is null`;
    expect(await waitFor(() => cA.some((c) => c.new.end_reason === 'delivered_by_other'))).toBe(
      true,
    );
    await sleep(3000);
    expect(cB.filter((c) => c.new.delivery_id === w.deliveries.dA1.id)).toHaveLength(0);
  });

  it('rejected courier actions are streamed only to that courier (and dispatchers)', async () => {
    const cA = await listen(w.sessions.courierA, ['courier_actions']);
    const cB = await listen(w.sessions.courierB, ['courier_actions']);
    const disp = await listen(w.sessions.dispatcher, ['courier_actions']);
    const actionId = randomUUID();
    await sql`insert into public.courier_actions (courier_id, client_action_id, delivery_id, type, device_time, result, reject_code, reject_message)
      values (${w.users.courierA.id}, ${actionId}, ${w.deliveries.dA1.id}, 'deliver', now(), 'rejected', 'WRONG_CODE', 'wrong code')`;
    expect(
      await waitFor(
        () =>
          cA.some((c) => c.new.client_action_id === actionId) &&
          disp.some((c) => c.new.client_action_id === actionId),
      ),
    ).toBe(true);
    await sleep(3000);
    expect(cB.filter((c) => c.new.client_action_id === actionId)).toHaveLength(0);
  });

  it('shifts changes reach the courier and dispatchers only', async () => {
    const cA = await listen(w.sessions.courierA, ['shifts']);
    const sA = await listen(w.sessions.senderA, ['shifts']);
    const disp = await listen(w.sessions.dispatcher, ['shifts']);
    // an "update" that does not change data still produces a WAL record
    await sql`update public.shifts set opened_at = opened_at where id = ${w.shifts.A}`;
    expect(await waitFor(() => cA.length > 0 && disp.some((c) => c.new.id === w.shifts.A))).toBe(
      true,
    );
    await sleep(2500);
    expect(sA).toHaveLength(0);
  });
});

describe('tracking Broadcast: live, safe, and only on the unguessable channel', () => {
  type Msg = { event: string; payload: Record<string, unknown> };

  async function trackingListener(client: SupabaseClient, channel: string): Promise<Msg[]> {
    const msgs: Msg[] = [];
    const ch = client
      .channel(`tracking:${channel}`)
      .on('broadcast', { event: 'tracking' }, (m) =>
        msgs.push({ event: m.event, payload: m.payload as Record<string, unknown> }),
      );
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('subscribe timeout')), 15_000);
      ch.subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          clearTimeout(t);
          resolve();
        }
      });
    });
    channels.push({ client, name: channel });
    return msgs;
  }

  it('anonymous recipient receives status updates with a minimal payload — no address, phone or code', async () => {
    const d = await createDelivery(sql, { senderId: w.users.senderA.id, codKop: 99_900 });
    const other = await createDelivery(sql, { senderId: w.users.senderA.id });
    const anon = anonClient();
    const msgs = await trackingListener(anon, d.trackingChannel);
    const strangerMsgs = await trackingListener(anonClient(), other.trackingChannel);
    const guessed = await trackingListener(anonClient(), 'A'.repeat(22));
    await sleep(1500);

    await assignDelivery(sql, d.id, w.users.courierA.id, w.users.dispatcher.id);
    await pickUpDelivery(sql, d.id, w.users.courierA.id);

    expect(await waitFor(() => msgs.some((m) => m.payload.status === 'picked_up'))).toBe(true);
    const statuses = msgs.map((m) => m.payload.status);
    expect(statuses).toEqual(['assigned', 'picked_up']);

    for (const m of msgs) {
      // `id` is a random message id added by Realtime itself (not the delivery id)
      expect(Object.keys(m.payload).sort()).toEqual([
        'amountDueKop',
        'attemptNo',
        'courierName',
        'id',
        'number',
        'status',
        'updatedAt',
      ]);
      expect(m.payload.id).not.toBe(d.id);
      const text = JSON.stringify(m.payload);
      expect(text).not.toContain('+380671234567'); // phone
      expect(text).not.toContain('Test St'); // street
      expect(text).not.toContain(d.code); // handover code is shown on the page, but never broadcast
      expect(text).not.toContain(d.trackingToken);
      expect(text).not.toContain('Test Recipient');
      expect(m.payload.number).toBe(d.publicNumber);
      expect(m.payload.amountDueKop).toBe(99_900);
      expect(m.payload.courierName).toMatch(/^\S+ \S\.$/); // "First L."
    }
    await sleep(2000);
    expect(strangerMsgs).toHaveLength(0);
    expect(guessed).toHaveLength(0);
  });

  it('wrong_code events (no status change) produce no broadcast', async () => {
    const d = await createDelivery(sql, { senderId: w.users.senderA.id });
    await sleep(3000); // let the broadcast for the `created` event flush before we subscribe
    const msgs = await trackingListener(anonClient(), d.trackingChannel);
    await sleep(1500);
    await sql`insert into public.delivery_events (delivery_id, type, actor_role, payload) values (${d.id}, 'wrong_code', 'courier', '{}')`;
    await sleep(2500);
    expect(msgs).toHaveLength(0);
  });

  it('postgres_changes on deliveries gives anonymous clients nothing (so tracking must use Broadcast)', async () => {
    const d = await createDelivery(sql, { senderId: w.users.senderA.id });
    const rows = await listen(null, ['deliveries']);
    await assignDelivery(sql, d.id, w.users.courierA.id);
    await sleep(3500);
    // at most an error stub without any record
    for (const r of rows) {
      expect(Object.keys(r.new ?? {})).toHaveLength(0);
      expect(JSON.stringify(r)).not.toContain(d.id);
    }
  });
});
