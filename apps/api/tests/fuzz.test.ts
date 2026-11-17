import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import {
  act,
  assign,
  createViaApi,
  jpeg,
  makeActors,
  rawCall,
  useHarness,
  validBody,
  type Actors,
} from './harness';

// Invariant 15: bad input is a 4xx, never a 5xx, and always in the uniform error format.
const h = useHarness();
const T = 300_000;

const SEED = 20260517;
const sample = <T>(arb: fc.Arbitrary<T>, n: number, offset = 0): T[] =>
  fc.sample(arb, { numRuns: n, seed: SEED + offset });

const weird = fc.oneof(
  fc.jsonValue(),
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.constant(null),
  fc.integer(),
  fc.double({ noNaN: false }),
  fc.constantFrom(
    '',
    ' ',
    '\u0000',
    '\n',
    '😀',
    "'; DROP TABLE deliveries; --",
    '<script>',
    '../../x',
    '%',
    '\\',
    'null',
    'undefined',
    '__proto__',
    '9'.repeat(400),
  ),
  fc.array(fc.jsonValue(), { maxLength: 5 }),
);

/** A valid object with one random field replaced by a weird value (finds validation holes deep inside). */
const mutate = (base: Record<string, unknown>) =>
  fc.tuple(fc.constantFrom(...Object.keys(base)), weird).map(([k, v]) => ({ ...base, [k]: v }));

type Call = {
  name: string;
  method: string;
  path: string;
  body?: string;
  token?: string;
  headers?: Record<string, string>;
  ct?: string;
  bin?: Buffer;
};

type Ctx = { a: Actors; delivery: string; token: string };

function buildCalls(c: Ctx): Call[] {
  const calls: Call[] = [];
  const add = (x: Call) => calls.push(x);
  const roles = {
    sender: c.a.sender.accessToken,
    dispatcher: c.a.dispatcher.accessToken,
    courier: c.a.courier.accessToken,
    none: undefined as string | undefined,
  };
  const ids = [c.delivery, randomUUID(), 'x', '1', '%', "'", '0'.repeat(36), '../etc'];
  const encode = (s: string) => encodeURIComponent(s);
  const bodyOf = (v: unknown) =>
    typeof v === 'string' && Math.random() < 0 ? v : JSON.stringify(v);

  // JSON bodies at every writing route, with every role (wrong roles must be 401/403, never 5xx)
  const createBase = validBody();
  const quoteBase = { zone: 'A', weightG: 100, codKop: 0 };
  const actionBase = {
    type: 'pickup',
    clientActionId: randomUUID(),
    deliveryId: c.delivery,
    deviceTime: new Date().toISOString(),
  };
  const deliverBase = {
    ...actionBase,
    type: 'deliver',
    code: '123456',
    codCollectedKop: 0,
    photoId: randomUUID(),
  };
  const failBase = { ...actionBase, type: 'fail', reason: 'no_access', photoId: randomUUID() };

  const bodies: [string, string, string, unknown[], string[]][] = [
    [
      'create',
      'POST',
      '/deliveries',
      [...sample(weird, 40), ...sample(mutate(createBase), 120, 1)],
      ['sender', 'courier', 'none'],
    ],
    [
      'quote',
      'POST',
      '/deliveries/quote',
      [...sample(weird, 30), ...sample(mutate(quoteBase), 80, 2)],
      ['sender', 'dispatcher'],
    ],
    [
      'assign',
      'POST',
      `/dispatch/deliveries/${c.delivery}/assign`,
      [
        ...sample(weird, 30),
        ...sample(mutate({ courierId: c.a.courier.user.id, reassign: false }), 60, 3),
      ],
      ['dispatcher', 'sender'],
    ],
    [
      'close shift',
      'POST',
      `/dispatch/couriers/${c.a.courier2.user.id}/shift/close`,
      [...sample(weird, 30), ...sample(mutate({ handedCashKop: 0 }), 40, 4)],
      ['dispatcher'],
    ],
    [
      'actions',
      'POST',
      '/courier/actions',
      [
        ...sample(weird, 40),
        ...sample(
          weird.map((w) => ({ actions: w })),
          40,
          5,
        ),
        ...sample(
          mutate(actionBase).map((x) => ({ actions: [x] })),
          80,
          6,
        ),
        ...sample(
          mutate(deliverBase).map((x) => ({ actions: [x] })),
          80,
          7,
        ),
        ...sample(
          mutate(failBase).map((x) => ({ actions: [x] })),
          80,
          8,
        ),
      ],
      ['courier', 'sender'],
    ],
  ];
  for (const [name, method, path, values, who] of bodies) {
    for (const [i, v] of values.entries()) {
      const r = who[i % who.length]!;
      add({
        name: `${name} as ${r}`,
        method,
        path,
        body: bodyOf(v),
        token: roles[r as keyof typeof roles],
        headers: name === 'create' ? { 'Idempotency-Key': `fuzz-${randomUUID()}` } : undefined,
      });
    }
  }

  // path parameters
  for (const id of ids) {
    for (const [method, path, who] of [
      ['GET', `/deliveries/${encode(id)}`, 'sender'],
      ['GET', `/deliveries/${encode(id)}/photos`, 'sender'],
      ['POST', `/deliveries/${encode(id)}/cancel`, 'sender'],
      ['POST', `/dispatch/deliveries/${encode(id)}/unblock`, 'dispatcher'],
      ['POST', `/dispatch/deliveries/${encode(id)}/returned`, 'dispatcher'],
      ['POST', `/dispatch/deliveries/${encode(id)}/assign`, 'dispatcher'],
      ['GET', `/dispatch/couriers/${encode(id)}/shift`, 'dispatcher'],
      ['POST', `/dispatch/couriers/${encode(id)}/shift/close`, 'dispatcher'],
      ['GET', `/tracking/${encode(id)}`, 'none'],
    ] as const) {
      add({
        name: `${method} ${path.replace(encode(id), ':x')}`,
        method,
        path,
        token: roles[who],
        body: method === 'POST' ? '{}' : undefined,
      });
    }
  }

  // query strings
  const qWeird = fc.oneof(
    fc.record(
      { q: weird, status: weird, from: weird, to: weird, page: weird, pageSize: weird },
      { requiredKeys: [] },
    ),
    fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 20 }), { maxKeys: 6 }),
  );
  const qs = (o: Record<string, unknown>) =>
    Object.entries(o)
      .map(([k, v]) => `${encode(k)}=${encode(typeof v === 'string' ? v : JSON.stringify(v))}`)
      .join('&');
  for (const [i, o] of sample(qWeird, 150, 9).entries()) {
    add({ name: 'list query', method: 'GET', path: `/deliveries?${qs(o)}`, token: roles.sender });
    add({
      name: 'dispatch list query',
      method: 'GET',
      path: `/dispatch/deliveries?${qs(o)}`,
      token: roles.dispatcher,
    });
    if (i % 2)
      add({
        name: 'report query',
        method: 'GET',
        path: `/dispatch/report?${qs(o)}`,
        token: roles.dispatcher,
      });
  }
  for (const o of sample(fc.record({ from: weird, to: weird }), 60, 10))
    add({
      name: 'report query',
      method: 'GET',
      path: `/dispatch/report?${qs(o)}`,
      token: roles.dispatcher,
    });

  // photo upload: random bytes, random content types, random query
  const types = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/octet-stream',
    'text/plain',
    'application/json',
    'multipart/form-data; boundary=x',
    '',
  ];
  for (const [i, bytes] of sample(fc.uint8Array({ maxLength: 200 }), 60, 11).entries()) {
    const withMagic =
      i % 3 === 0 ? Buffer.concat([jpeg(''), Buffer.from(bytes)]) : Buffer.from(bytes);
    add({
      name: 'photo upload',
      method: 'PUT',
      token: roles.courier,
      bin: withMagic,
      ct: types[i % types.length],
      path: `/courier/photos/${i % 4 === 0 ? randomUUID() : encode(String(i))}?deliveryId=${i % 2 ? c.delivery : encode(String(i))}&kind=${i % 5 === 0 ? 'handover' : encode(String(i))}`,
    });
  }
  // plain GETs with every role
  for (const path of [
    '/me',
    '/deliveries',
    '/dispatch/board',
    '/dispatch/deliveries',
    '/courier/today',
    '/courier/actions/rejected',
    '/health',
    '/docs-json',
  ]) {
    for (const r of Object.keys(roles))
      add({
        name: `GET ${path} as ${r}`,
        method: 'GET',
        path,
        token: roles[r as keyof typeof roles],
      });
  }
  return calls;
}

describe('invariant 15: invalid input is a 4xx, never a 5xx', () => {
  it(
    'about 2000 hostile and malformed requests across every route, role and parameter',
    async () => {
      const a = await makeActors(h.sql);
      const d = await createViaApi(h, a.sender.accessToken);
      await assign(h, a.dispatcher.accessToken, d.id, a.courier.user.id);
      void act;
      const calls = buildCalls({ a, delivery: d.id, token: d.trackingToken });
      expect(calls.length).toBeGreaterThan(1200);

      const bad: string[] = [];
      const shapeErrors: string[] = [];
      const histogram = new Map<number, number>();
      let i = 0;
      await Promise.all(
        Array.from({ length: 24 }, async () => {
          for (;;) {
            const c = calls[i++];
            if (!c) return;
            const headers: Record<string, string> = { ...(c.headers ?? {}) };
            if (c.bin) headers['Content-Type'] = c.ct ?? 'application/octet-stream';
            const r = await rawCall(h, '127.0.0.60', c.method, c.path, {
              token: c.token,
              body: c.bin ?? c.body,
              headers,
              timeoutMs: 30_000,
            }).catch((e: Error) => ({ status: -1, body: e.message, headers: {}, ms: 0 }));
            histogram.set(r.status, (histogram.get(r.status) ?? 0) + 1);
            if (r.status >= 500 || r.status < 0)
              bad.push(
                `${r.status} ${c.name} ${c.method} ${c.path.slice(0, 80)} ${c.body?.slice(0, 100) ?? ''} -> ${JSON.stringify(r.body).slice(0, 160)}`,
              );
            else if (r.status >= 400) {
              const b = r.body as { error?: { code?: unknown; message?: unknown } };
              const okShape =
                typeof b?.error?.code === 'string' && typeof b?.error?.message === 'string';
              // /docs-json etc. are not part of the error contract, everything else is
              if (!okShape)
                shapeErrors.push(
                  `${r.status} ${c.method} ${c.path.slice(0, 80)} -> ${JSON.stringify(r.body).slice(0, 120)}`,
                );
            }
          }
        }),
      );
      console.info('fuzz status histogram', Object.fromEntries([...histogram].sort()));
      // the fuzzer must reach deep: lots of rejections of different kinds AND some requests that actually succeed
      for (const code of [200, 400, 401, 403, 404])
        expect(histogram.get(code) ?? 0, `no ${code} responses`).toBeGreaterThan(0);
      expect(histogram.get(400)!).toBeGreaterThan(400);
      expect([...histogram.keys()].filter((k) => k >= 200 && k < 300).length).toBeGreaterThan(0);
      expect(bad, bad.slice(0, 10).join('\n')).toEqual([]);
      expect(shapeErrors, shapeErrors.slice(0, 10).join('\n')).toEqual([]);
      // the server and the database are still healthy and consistent
      expect((await rawCall(h, '127.0.0.61', 'GET', '/health')).status).toBe(200);
      const [g] = await h.sql<
        { n: number; mx: number }[]
      >`select count(*)::int n, max(number)::int mx from public.deliveries`;
      expect(g!.n).toBe(g!.mx);
    },
    T,
  );

  it('SQL injection strings in every free-text input are stored or refused, never executed', async () => {
    const a = await makeActors(h.sql);
    const evil = [
      "'; DROP TABLE deliveries; --",
      "' OR '1'='1",
      '"; select pg_sleep(10); --',
      "\\'",
      '${jndi:ldap://x}',
      '{{7*7}}',
      '<img src=x onerror=alert(1)>',
    ];
    for (const s of evil) {
      const r = await rawCall(h, '127.0.0.62', 'POST', '/deliveries', {
        token: a.sender.accessToken,
        headers: { 'Idempotency-Key': `evil-${randomUUID()}` },
        body: JSON.stringify(
          validBody({ recipientName: s, address: { city: s, street: s, house: s, note: s } }),
        ),
      });
      expect(r.status, s).toBeLessThan(500);
      const q = await rawCall(h, '127.0.0.62', 'GET', `/deliveries?q=${encodeURIComponent(s)}`, {
        token: a.sender.accessToken,
      });
      expect(q.status).toBeLessThan(500);
    }
    const [t] = await h.sql<{ n: number }[]>`select count(*)::int n from public.deliveries`;
    expect(t!.n).toBeGreaterThan(50_000);
    const stored =
      await h.sql`select recipient_name from public.deliveries where sender_id = ${a.sender.user.id}`;
    for (const row of stored) expect(evil).toContain(row.recipient_name); // stored verbatim, as data
  });
});
