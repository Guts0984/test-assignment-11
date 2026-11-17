import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useDb } from './db';
import { buildWorld, readAs, type World } from './world';
import { adminClient, anonClient, createTestUser, signIn, DEMO } from '../src/testing/users';
import { signJwt, unsignedJwt } from '../src/testing/jwt';
import { testEnv } from '../src/testing/env';
import { createProfiled } from '../src/testing/fixtures';

const { sql } = useDb(10);
const env = testEnv();
let w: World;

beforeAll(async () => {
  w = await buildWorld(sql);
}, 120_000);

const ROLES = [
  'senderA',
  'senderB',
  'courierA',
  'courierB',
  'dispatcher',
  'sneaky',
  'anon',
] as const;
type RoleKey = (typeof ROLES)[number];
const clientFor = (r: RoleKey) => (r === 'anon' ? anonClient() : w.sessions[r].client);

const ALL_TABLES = [
  'profiles',
  'senders',
  'sender_webhooks',
  'couriers',
  'delivery_number_counter',
  'shifts',
  'deliveries',
  'delivery_secrets',
  'idempotency_keys',
  'assignments',
  'delivery_events',
  'courier_actions',
  'photos',
  'cash_adjustments',
  'notifications',
  'notification_attempts',
];

describe('visibility matrix: role × table, checked against ground truth (invariant 12)', () => {
  const ids = () => ({
    dA1: w.deliveries.dA1.id,
    dA2: w.deliveries.dA2.id,
    dB1: w.deliveries.dB1.id,
  });
  const allDeliveryIds = () => Object.values(ids());

  type Expectation = Record<RoleKey, string[]>;
  const none: Pick<Expectation, 'sneaky' | 'anon'> = { sneaky: [], anon: [] };

  const cases: {
    table: string;
    column: string;
    expected: () => Expectation;
    values: () => string[];
  }[] = [
    {
      table: 'deliveries',
      column: 'id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [ids().dA1, ids().dA2],
        senderB: [ids().dB1],
        courierA: [ids().dA1],
        courierB: [ids().dB1],
        dispatcher: allDeliveryIds(),
        ...none,
      }),
    },
    {
      table: 'assignments',
      column: 'delivery_id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [],
        senderB: [],
        courierA: [ids().dA1],
        courierB: [ids().dB1],
        dispatcher: [ids().dA1, ids().dB1],
        ...none,
      }),
    },
    {
      table: 'delivery_events',
      column: 'delivery_id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [ids().dA1, ids().dA2],
        senderB: [ids().dB1],
        courierA: [ids().dA1],
        courierB: [ids().dB1],
        dispatcher: allDeliveryIds(),
        ...none,
      }),
    },
    {
      table: 'photos',
      column: 'delivery_id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [ids().dA1],
        senderB: [ids().dB1],
        courierA: [ids().dA1],
        courierB: [ids().dB1],
        dispatcher: [ids().dA1, ids().dB1],
        ...none,
      }),
    },
    {
      table: 'courier_actions',
      column: 'delivery_id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [],
        senderB: [],
        courierA: [ids().dA1],
        courierB: [ids().dB1],
        dispatcher: [ids().dA1, ids().dB1],
        ...none,
      }),
    },
    {
      table: 'notifications',
      column: 'delivery_id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [ids().dA1, ids().dA2],
        senderB: [ids().dB1],
        courierA: [],
        courierB: [],
        dispatcher: [],
        ...none,
      }),
    },
    {
      table: 'shifts',
      column: 'courier_id',
      values: () => [w.users.courierA.id, w.users.courierB.id],
      expected: () => ({
        senderA: [],
        senderB: [],
        courierA: [w.users.courierA.id],
        courierB: [w.users.courierB.id],
        dispatcher: [w.users.courierA.id, w.users.courierB.id],
        ...none,
      }),
    },
    {
      table: 'cash_adjustments',
      column: 'delivery_id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [],
        senderB: [],
        courierA: [],
        courierB: [],
        dispatcher: [ids().dA1],
        ...none,
      }),
    },
    {
      table: 'couriers',
      column: 'user_id',
      values: () => [w.users.courierA.id, w.users.courierB.id],
      expected: () => ({
        senderA: [],
        senderB: [],
        courierA: [w.users.courierA.id],
        courierB: [w.users.courierB.id],
        dispatcher: [w.users.courierA.id, w.users.courierB.id],
        ...none,
      }),
    },
    {
      table: 'senders',
      column: 'user_id',
      values: () => [w.users.senderA.id, w.users.senderB.id],
      expected: () => ({
        senderA: [w.users.senderA.id],
        senderB: [w.users.senderB.id],
        courierA: [],
        courierB: [],
        dispatcher: [w.users.senderA.id, w.users.senderB.id],
        ...none,
      }),
    },
    {
      table: 'sender_webhooks',
      column: 'sender_id',
      values: () => [w.users.senderA.id, w.users.senderB.id],
      // the signing secret: its owner only. Not even dispatchers.
      expected: () => ({
        senderA: [w.users.senderA.id],
        senderB: [w.users.senderB.id],
        courierA: [],
        courierB: [],
        dispatcher: [],
        ...none,
      }),
    },
    {
      table: 'profiles',
      column: 'user_id',
      values: () => Object.values(w.users).map((u) => u.id),
      expected: () => ({
        senderA: [w.users.senderA.id],
        senderB: [w.users.senderB.id],
        courierA: [w.users.courierA.id],
        courierB: [w.users.courierB.id],
        dispatcher: [
          w.users.senderA.id,
          w.users.senderB.id,
          w.users.courierA.id,
          w.users.courierB.id,
          w.users.dispatcher.id,
        ],
        sneaky: [],
        anon: [],
      }),
    },
    // No policy at all: nobody reads these through the API, not even the owner or the dispatcher.
    {
      table: 'delivery_secrets',
      column: 'delivery_id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [],
        senderB: [],
        courierA: [],
        courierB: [],
        dispatcher: [],
        ...none,
      }),
    },
    {
      table: 'idempotency_keys',
      column: 'delivery_id',
      values: allDeliveryIds,
      expected: () => ({
        senderA: [],
        senderB: [],
        courierA: [],
        courierB: [],
        dispatcher: [],
        ...none,
      }),
    },
    {
      table: 'delivery_number_counter',
      column: 'id',
      values: () => ['1'],
      expected: () => ({
        senderA: [],
        senderB: [],
        courierA: [],
        courierB: [],
        dispatcher: [],
        ...none,
      }),
    },
  ];

  for (const c of cases) {
    for (const role of ROLES) {
      it(`${role} reading ${c.table}`, async () => {
        const expectedKeys = [...new Set(c.expected()[role])].sort();
        const { rows, errorCode } = await readAs(clientFor(role), c.table, c.column, c.values());
        if (errorCode) expect(errorCode, 'only a permission error is acceptable').toBe('42501');
        const seen = [...new Set(rows.map((r) => String(r[c.column])))].sort();
        expect(seen).toEqual(expectedKeys);
      });
    }
  }

  it('the matrix covers every table in the schema', async () => {
    const covered = new Set(cases.map((c) => c.table));
    const missing = ALL_TABLES.filter((t) => !covered.has(t) && t !== 'notification_attempts');
    expect(missing).toEqual([]);
  });

  it('notification_attempts: a sender sees only attempts of their own notifications', async () => {
    const a = await w.sessions.senderA.client
      .from('notification_attempts')
      .select('notification_id');
    const seen = new Set((a.data ?? []).map((r) => r.notification_id));
    expect(seen.size).toBeGreaterThan(0);
    for (const id of seen) expect(w.notificationIds.A).toContain(id);
    for (const id of w.notificationIds.B) expect(seen.has(id)).toBe(false);
    const c = await w.sessions.courierA.client.from('notification_attempts').select('id');
    expect(c.data ?? []).toHaveLength(0);
    const an = await anonClient().from('notification_attempts').select('id');
    expect(an.data ?? []).toHaveLength(0);
  });

  it('every table in public has RLS enabled (no table can be forgotten)', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it('anon and authenticated hold no write privilege on any table or sequence', async () => {
    const rows =
      await sql`select grantee, table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'`;
    expect(rows).toEqual([]);
    const anonSelect = await sql`select table_name from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon'`;
    expect(anonSelect).toEqual([]);
  });
});

describe('seeded users see exactly their own data (counts equal independent SQL ground truth)', () => {
  it('sender 1 sees every one of their 17k-ish deliveries and nothing else', async () => {
    const s = await signIn(DEMO.sender(1), DEMO.senderPassword);
    const res = await s.client.from('deliveries').select('id', { count: 'exact', head: true });
    const [truth] = await sql<
      { n: number }[]
    >`select count(*)::int n from public.deliveries where sender_id = ${DEMO.senderId(1)}`;
    expect(res.count).toBe(truth!.n);
    expect(truth!.n).toBeGreaterThan(10000);
    // and with a filter that tries to reach another sender's rows
    const other = await s.client
      .from('deliveries')
      .select('id')
      .eq('sender_id', DEMO.senderId(2))
      .limit(5);
    expect(other.data ?? []).toHaveLength(0);
  });

  it('courier 3 sees only deliveries where they are the courier', async () => {
    const c = await signIn(DEMO.courier(3), DEMO.courierPassword);
    const res = await c.client.from('deliveries').select('id', { count: 'exact', head: true });
    const [truth] = await sql<
      { n: number }[]
    >`select count(*)::int n from public.deliveries where courier_id = ${DEMO.courierId(3)}`;
    expect(res.count).toBe(truth!.n);
    const queue = await c.client.from('deliveries').select('id').eq('status', 'created').limit(5);
    expect(queue.data ?? []).toHaveLength(0); // the unassigned queue is invisible to couriers
  });

  it('dispatcher sees all 50 000+ deliveries', async () => {
    const d = await signIn(DEMO.dispatcher(1), DEMO.dispatcherPassword);
    const res = await d.client.from('deliveries').select('id', { count: 'exact', head: true });
    const [truth] = await sql<{ n: number }[]>`select count(*)::int n from public.deliveries`;
    expect(res.count).toBe(truth!.n);
  });
});

describe('embedding cannot be used to read around the policies', () => {
  it('a sender reading a delivery cannot embed the courier or their profile (name, phone)', async () => {
    const { data, error } = await w.sessions.senderA.client
      .from('deliveries')
      .select('id, couriers(user_id, profiles(full_name, phone))')
      .eq('id', w.deliveries.dA1.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data![0] as { couriers: unknown }).couriers).toBeNull();
  });

  it('nobody can embed delivery_secrets (recipient code / tracking token) through a delivery', async () => {
    for (const r of ['senderA', 'courierA', 'dispatcher'] as const) {
      const { data, error } = await w.sessions[r].client
        .from('deliveries')
        .select('id, delivery_secrets(recipient_code, tracking_token)')
        .eq('id', w.deliveries.dA1.id);
      const leaked = JSON.stringify(data ?? []);
      expect(leaked).not.toContain(w.deliveries.dA1.code);
      expect(leaked).not.toContain(w.deliveries.dA1.trackingToken);
      expect(error?.code ?? 'none').toMatch(/42501|PGRST200|none/);
    }
  });

  it('a courier cannot read the recipient code or tracking token of their own delivery', async () => {
    const { data } = await w.sessions.courierA.client.from('delivery_secrets').select('*');
    expect(data ?? []).toHaveLength(0);
    const own = await w.sessions.courierA.client
      .from('deliveries')
      .select('*')
      .eq('id', w.deliveries.dA1.id);
    expect(JSON.stringify(own.data)).not.toContain(w.deliveries.dA1.code);
    expect(JSON.stringify(own.data)).not.toContain(w.deliveries.dA1.trackingToken);
  });

  it('filter injection through PostgREST operators cannot widen the result', async () => {
    const c = w.sessions.senderB.client;
    for (const f of [
      `id.eq.${w.deliveries.dA1.id},sender_id.eq.${w.users.senderA.id}`,
      `sender_id.neq.${w.users.senderB.id}`,
      'id.not.is.null',
    ]) {
      const { data } = await c.from('deliveries').select('id, sender_id').or(f);
      for (const row of data ?? []) expect(row.sender_id).toBe(w.users.senderB.id);
    }
  });
});

// A real primary-key column and a real column to modify, so PostgREST gets as far as the privilege check.
const WRITE_TARGETS: Record<string, { pk: string; col: string; value: unknown }> = {
  profiles: { pk: 'user_id', col: 'full_name', value: 'hacked' },
  senders: { pk: 'user_id', col: 'company', value: 'hacked' },
  sender_webhooks: { pk: 'sender_id', col: 'url', value: 'http://evil.example/hook' },
  couriers: { pk: 'user_id', col: 'active', value: false },
  delivery_number_counter: { pk: 'id', col: 'value', value: 0 },
  shifts: { pk: 'id', col: 'closed_at', value: '2030-01-01T00:00:00Z' },
  deliveries: { pk: 'id', col: 'status', value: 'cancelled' },
  delivery_secrets: { pk: 'delivery_id', col: 'recipient_code', value: '000000' },
  idempotency_keys: { pk: 'sender_id', col: 'request_hash', value: 'x' },
  assignments: { pk: 'id', col: 'end_reason', value: 'cancelled' },
  delivery_events: { pk: 'id', col: 'payload', value: {} },
  courier_actions: { pk: 'courier_id', col: 'result', value: 'applied' },
  photos: { pk: 'id', col: 'kind', value: 'failed' },
  cash_adjustments: { pk: 'id', col: 'amount_kop', value: 0 },
  notifications: { pk: 'id', col: 'status', value: 'delivered' },
  notification_attempts: { pk: 'id', col: 'error', value: 'x' },
};

describe('writes from the browser are impossible, for every role on every table', () => {
  async function snapshot() {
    const counts = await Promise.all(
      ALL_TABLES.map(async (t) => {
        const [r] = await sql.unsafe(
          `select count(*)::int n, md5(coalesce(string_agg(x::text, '' order by x::text), '')) h from (select * from public.${t} ${
            t === 'delivery_events' || t === 'notifications' || t === 'notification_attempts'
              ? 'limit 0'
              : ''
          }) x`,
        );
        return [t, r] as const;
      }),
    );
    return Object.fromEntries(counts);
  }

  it('insert, update and delete are all refused with 42501 and change nothing', async () => {
    const before = await snapshot();
    const attempts: string[] = [];
    for (const role of ROLES) {
      const client = clientFor(role);
      for (const table of ALL_TABLES) {
        const ins = await client.from(table).insert({});
        const t = WRITE_TARGETS[table]!;
        const upd = await client
          .from(table)
          .update({ [t.col]: t.value })
          .not(t.pk, 'is', null);
        const del = await client.from(table).delete().not(t.pk, 'is', null);
        for (const [op, r] of [
          ['insert', ins],
          ['update', upd],
          ['delete', del],
        ] as const) {
          if (r.error?.code !== '42501')
            attempts.push(`${role} ${op} ${table}: ${JSON.stringify(r.error)} status ${r.status}`);
        }
      }
    }
    expect(attempts).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('a sender cannot cancel, re-price or re-assign their own delivery directly', async () => {
    const c = w.sessions.senderA.client;
    const before =
      await sql`select status, fee_kop, courier_id, total_kop from public.deliveries where id = ${w.deliveries.dA2.id}`;
    for (const patch of [
      { status: 'cancelled' },
      { fee_kop: 1, total_kop: 1 },
      { courier_id: w.users.courierB.id },
      { cod_kop: 0 },
    ]) {
      const r = await c.from('deliveries').update(patch).eq('id', w.deliveries.dA2.id).select();
      expect(r.error?.code).toBe('42501');
    }
    expect(
      await sql`select status, fee_kop, courier_id, total_kop from public.deliveries where id = ${w.deliveries.dA2.id}`,
    ).toEqual(before);
  });

  it('a courier cannot mark a delivery delivered or read-then-write another courier’s rows', async () => {
    const c = w.sessions.courierA.client;
    const r = await c
      .from('deliveries')
      .update({ status: 'delivered' })
      .eq('id', w.deliveries.dA1.id)
      .select();
    expect(r.error?.code).toBe('42501');
    const r2 = await c
      .from('deliveries')
      .update({ status: 'delivered' })
      .eq('id', w.deliveries.dB1.id)
      .select();
    expect(r2.error?.code).toBe('42501');
    const [row] = await sql`select status from public.deliveries where id = ${w.deliveries.dB1.id}`;
    expect(row!.status).toBe('assigned');
  });

  it('internal functions are not callable over RPC', async () => {
    for (const role of ROLES) {
      const c = clientFor(role);
      for (const fn of [
        'release_stale_assignments',
        'next_delivery_number',
        'is_valid_transition',
        'is_seeding',
      ]) {
        const r = await c.rpc(fn);
        expect(r.error, `${role} rpc ${fn}`).not.toBeNull();
        expect(r.data ?? null).toBeNull();
      }
      const r = await c
        .schema('app_private' as 'public')
        .from('deliveries' as never)
        .select('*');
      expect(r.error).not.toBeNull();
    }
  });
});

describe('roles cannot be forged or escalated', () => {
  it('a user cannot make themselves dispatcher by editing user_metadata', async () => {
    const u = await createProfiled(sql, 'courier');
    const authClient = anonClient();
    await authClient.auth.signInWithPassword({ email: u.email, password: u.password });
    const { error } = await authClient.auth.updateUser({ data: { role: 'dispatcher' } });
    expect(error).toBeNull(); // allowed, but it must be meaningless
    const re = await signIn(u.email, u.password);
    const claims = JSON.parse(Buffer.from(re.accessToken.split('.')[1]!, 'base64url').toString());
    expect(claims.user_metadata.role).toBe('dispatcher');
    expect(claims.app_metadata.role).toBe('courier');
    const all = await re.client.from('deliveries').select('id', { count: 'exact', head: true });
    const [mine] = await sql<
      { n: number }[]
    >`select count(*)::int n from public.deliveries where courier_id = ${u.id}`;
    expect(all.count).toBe(mine!.n);
    const shifts = await re.client.from('shifts').select('courier_id').neq('courier_id', u.id);
    expect(shifts.data ?? []).toHaveLength(0);
  });

  it('a user cannot write app_metadata through the Auth API', async () => {
    const u = await createProfiled(sql, 'sender');
    const s = await signIn(u.email, u.password);
    const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${s.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ app_metadata: { role: 'dispatcher' }, data: { x: 1 } }),
    });
    await res.text();
    const re = await signIn(u.email, u.password);
    const claims = JSON.parse(Buffer.from(re.accessToken.split('.')[1]!, 'base64url').toString());
    expect(claims.app_metadata.role).toBe('sender');
  });

  it('a user whose role exists only in user_metadata has no data access at all', async () => {
    const { data } = await w.sessions.sneaky.client.from('deliveries').select('id').limit(5);
    expect(data ?? []).toHaveLength(0);
    const p = await w.sessions.sneaky.client.from('profiles').select('user_id');
    expect(p.data ?? []).toHaveLength(0);
  });

  it('self sign-up is disabled', async () => {
    const { data, error } = await anonClient().auth.signUp({
      email: `hacker-${randomUUID()}@example.com`,
      password: 'Hacker-Pass-123',
    });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it('Auth admin endpoints refuse user tokens', async () => {
    for (const r of ['senderA', 'courierA', 'dispatcher'] as const) {
      const res = await fetch(`${env.supabaseUrl}/auth/v1/admin/users`, {
        headers: { apikey: env.anonKey, Authorization: `Bearer ${w.sessions[r].accessToken}` },
      });
      expect([401, 403]).toContain(res.status);
      const created = await fetch(`${env.supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey: env.anonKey,
          Authorization: `Bearer ${w.sessions[r].accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: `x-${randomUUID()}@example.com`,
          password: 'Xx-123456789',
          app_metadata: { role: 'dispatcher' },
        }),
      });
      expect([401, 403]).toContain(created.status);
    }
  });

  const rest = (token: string) =>
    fetch(`${env.supabaseUrl}/rest/v1/deliveries?select=id&limit=1`, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${token}` },
    });
  const claims = (extra: Record<string, unknown> = {}) => ({
    aud: 'authenticated',
    role: 'authenticated',
    sub: w.users.dispatcher.id,
    app_metadata: { role: 'dispatcher' },
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  });

  it('a token signed with the wrong secret is rejected', async () => {
    expect((await rest(signJwt(claims(), 'x'.repeat(40)))).status).toBe(401);
  });
  it('an unsigned (alg: none) token is rejected', async () => {
    expect((await rest(unsignedJwt(claims()))).status).toBe(401);
  });
  it('a token with a stripped signature is rejected', async () => {
    const good = w.sessions.courierA.accessToken;
    const [h, p] = good.split('.');
    expect((await rest(`${h}.${p}.`)).status).toBe(401);
    expect((await rest(`${h}.${p}.AAAA`)).status).toBe(401);
  });
  it('a real token with its payload edited (role → dispatcher) is rejected', async () => {
    const [h, p, s] = w.sessions.courierA.accessToken.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.app_metadata.role = 'dispatcher';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect((await rest(forged)).status).toBe(401);
  });
  it('an expired token is rejected even when signed correctly', async () => {
    expect(
      (await rest(signJwt(claims({ exp: Math.floor(Date.now() / 1000) - 60 }), env.jwtSecret)))
        .status,
    ).toBe(401);
  });
  it('a request without any key is rejected', async () => {
    const res = await fetch(`${env.supabaseUrl}/rest/v1/deliveries?select=id&limit=1`);
    expect(res.status).toBe(401);
  });
  it('the anon key as bearer sees nothing', async () => {
    const res = await rest(env.anonKey);
    expect([401, 403]).toContain(res.status);
  });
});

afterAll(async () => {
  await adminClient()
    .auth.signOut()
    .catch(() => undefined);
  void createTestUser;
});
