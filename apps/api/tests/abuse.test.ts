import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRateLimiter } from '../src/domain/rate-limit';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { signJwt, unsignedJwt, testEnv } from '@courier/db/testing';
import {
  call,
  createViaApi,
  idemKey,
  makeActors,
  percentile,
  rawCall,
  slowSocket,
  useHarness,
  validBody,
  type Actors,
} from './harness';

// A server with REAL (scaled-down) limits. The functional suites run with limits switched off.
const LIMITS = {
  RATE_LIMIT_IP_PER_MINUTE: '120', // burst 60
  RATE_LIMIT_USER_PER_MINUTE: '120',
  RATE_LIMIT_SENSITIVE_PER_MINUTE: '20', // burst 10
  RATE_LIMIT_TRACKING_PER_MINUTE: '30', // burst 15
  MAX_INFLIGHT_PER_IP: '8',
  MAX_INFLIGHT_GLOBAL: '64',
  HEADERS_TIMEOUT_MS: '1500',
  REQUEST_TIMEOUT_MS: '5000',
};
const h = useHarness({ env: LIMITS });
const ATTACKER = '127.0.0.2';
const VICTIM = '127.0.0.3';
const T = 120_000;

let actors: Actors;
const world = async () => (actors ??= await makeActors(h.sql));

/** Runs `n` calls with at most `c` in flight. */
async function pool<T>(n: number, c: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: c }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        out[i] = await fn(i).catch((e) => e as T);
      }
    }),
  );
  return out;
}

describe('a spamming attacker cannot take everyone else down (per-IP isolation)', () => {
  it(
    '3000 requests from one IP are throttled while a victim on another IP keeps full service',
    async () => {
      const a = await makeActors(h.sql);
      const d = await createViaApi(h, a.sender.accessToken);
      let stop = false;
      const flood = (async () => {
        const results: number[] = [];
        await pool(3000, 60, async () => {
          if (stop) return;
          const r = await rawCall(h, ATTACKER, 'GET', '/health').catch(() => ({ status: 0 }));
          results.push(r.status);
        });
        return results;
      })();

      // meanwhile a real user on another address works normally: quotes, tracking, list
      const victim: { status: number; ms: number }[] = [];
      for (let i = 0; i < 30; i++) {
        victim.push(
          await rawCall(h, VICTIM, 'POST', '/deliveries/quote', {
            token: a.sender.accessToken,
            body: JSON.stringify({ zone: 'A', weightG: 500 }),
          }),
        );
        if (i < 10) victim.push(await rawCall(h, VICTIM, 'GET', `/tracking/${d.trackingToken}`)); // a recipient polls rarely
      }
      stop = true;
      const attacker = await flood;
      expect(victim.every((v) => v.status === 200)).toBe(true);
      expect(
        percentile(
          victim.map((v) => v.ms),
          0.95,
        ),
      ).toBeLessThan(1500);
      // the attacker is cut off: the vast majority of its requests are 429
      const limited = attacker.filter((s) => s === 429).length;
      const served = attacker.filter((s) => s === 200).length;
      expect(limited).toBeGreaterThan(served * 3);
      expect(served).toBeLessThan(400);
      expect(attacker.filter((s) => s >= 500)).toHaveLength(0);
    },
    T,
  );

  it(
    '429s carry Retry-After and the uniform error body; waiting makes the limit recover',
    async () => {
      const ip = '127.0.0.20';
      let first429: Awaited<ReturnType<typeof rawCall>> | undefined;
      for (let i = 0; i < 200 && !first429; i++) {
        const r = await rawCall(h, ip, 'GET', '/health');
        if (r.status === 429) first429 = r;
      }
      expect(first429).toBeDefined();
      expect(first429!.headers['retry-after']).toMatch(/^\d+$/);
      expect(first429!.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      h.clock.advance(120_000);
      expect((await rawCall(h, ip, 'GET', '/health')).status).toBe(200);
      h.clock.set(new Date());
    },
    T,
  );

  it(
    'spoofed X-Forwarded-For / X-Real-IP / Forwarded headers do not buy a fresh bucket (proxy headers are ignored)',
    async () => {
      const ip = '127.0.0.21';
      const statuses: number[] = [];
      for (let i = 0; i < 150; i++) {
        const r = await rawCall(h, ip, 'GET', '/health', {
          headers: {
            'X-Forwarded-For': `10.${i % 250}.${i % 7}.${i}`,
            'X-Real-IP': `172.16.${i}.1`,
            Forwarded: `for=192.0.2.${i}`,
            'X-Client-IP': `203.0.113.${i}`,
          },
        });
        statuses.push(r.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(50);
    },
    T,
  );

  it(
    'an attacker cannot burn the victim’s budget by claiming the victim’s address in X-Forwarded-For',
    async () => {
      const a = await world();
      for (let i = 0; i < 150; i++)
        await rawCall(h, '127.0.0.22', 'GET', '/health', {
          headers: { 'X-Forwarded-For': VICTIM },
        });
      const ok = await rawCall(h, '127.0.0.23', 'POST', '/deliveries/quote', {
        token: a.sender.accessToken,
        body: JSON.stringify({ zone: 'A', weightG: 1 }),
        headers: { 'X-Forwarded-For': '127.0.0.22' },
      });
      expect(ok.status).toBe(200);
    },
    T,
  );

  it(
    'in-flight fairness: one IP holding many slow requests does not starve another IP',
    async () => {
      const a = await world();
      const from = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const heavy = () =>
        rawCall(h, '127.0.0.24', 'GET', `/dispatch/report?from=${from}&to=${to}`, {
          token: a.dispatcher.accessToken,
        });
      const attackers = Promise.all(Array.from({ length: 60 }, heavy));
      await new Promise((r) => setTimeout(r, 50));
      const t = performance.now();
      const victim = await rawCall(h, VICTIM, 'GET', '/dispatch/board', {
        token: a.dispatcher.accessToken,
      });
      const took = performance.now() - t;
      const results = await attackers;
      expect(victim.status).toBe(200);
      expect(took).toBeLessThan(2000);
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0); // the fair-share gate engaged
      expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
    },
    T,
  );

  it(
    'sensitive routes have their own, stricter budget per user; other users are unaffected',
    async () => {
      const a = await makeActors(h.sql);
      const ip = '127.0.0.25';
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const r = await rawCall(h, ip, 'POST', '/deliveries', {
          token: a.sender.accessToken,
          body: JSON.stringify(validBody({ weightG: 100 + i })),
          headers: { 'Idempotency-Key': idemKey() },
        });
        statuses.push(r.status);
      }
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(8);
      expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(14);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10);
      const other = await rawCall(h, ip, 'POST', '/deliveries', {
        token: a.sender2.accessToken,
        body: JSON.stringify(validBody()),
        headers: { 'Idempotency-Key': idemKey() },
      });
      expect(other.status).toBe(201); // same IP, different user: not collateral damage
    },
    T,
  );

  it(
    'tracking enumeration is throttled per IP, and never reveals more than "not found"',
    async () => {
      const a = await makeActors(h.sql);
      const d = await createViaApi(h, a.sender.accessToken);
      const guesses = await pool(300, 4, () =>
        rawCall(
          h,
          '127.0.0.26',
          'GET',
          `/tracking/${randomUUID().replaceAll('-', '').slice(0, 22)}`,
        ),
      );
      const statuses = guesses.map((g) => (g as { status: number }).status);
      expect(statuses.filter((s) => s === 404).length).toBeLessThan(40);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(200);
      expect(statuses.filter((s) => s === 200)).toHaveLength(0);
      // a real recipient on another address is fine
      expect((await rawCall(h, VICTIM, 'GET', `/tracking/${d.trackingToken}`)).status).toBe(200);
    },
    T,
  );

  it(
    'requests rejected by the limiter never reach the database',
    async () => {
      const before =
        await h.sql`select count(*)::int n from pg_stat_activity where datname = current_database()`;
      await pool(500, 20, () => rawCall(h, '127.0.0.27', 'POST', '/deliveries', { body: '{}' }));
      const after =
        await h.sql`select count(*)::int n from pg_stat_activity where datname = current_database()`;
      expect(after[0]!.n - before[0]!.n).toBeLessThan(10);
    },
    T,
  );
});

describe('limiter memory stays bounded', () => {
  it('a flood of distinct identities cannot grow the tracked-key set past its cap', async () => {
    const l = createRateLimiter({ capacity: 5, perMinute: 60, maxKeys: 1000 });
    for (let i = 0; i < 100_000; i++) l.take(`ip:${i}`, 0);
    expect(l.size()).toBeLessThanOrEqual(1000);
  });
});

describe('slow-client attacks (slowloris)', () => {
  it(
    'sockets that never finish their request head are dropped quickly, and service continues meanwhile',
    async () => {
      const a = await world();
      const sockets = Array.from({ length: 150 }, (_, i) =>
        slowSocket(h, '127.0.0.30', `GET /health HTTP/1.1\r\nHost: x\r\nX-Slow-${i}: yes\r\n`),
      );
      await new Promise((r) => setTimeout(r, 300));
      const ok = await rawCall(h, VICTIM, 'POST', '/deliveries/quote', {
        token: a.sender.accessToken,
        body: JSON.stringify({ zone: 'A', weightG: 1 }),
      });
      expect(ok.status).toBe(200);
      const times = await Promise.all(sockets.map((s) => s.closed));
      expect(Math.max(...times)).toBeLessThan(5000); // headers timeout 1.5 s + sweep interval
      expect(Math.min(...times)).toBeGreaterThan(1000);
    },
    T,
  );

  it(
    'a trickling body is cut off by the request timeout',
    async () => {
      const s = slowSocket(
        h,
        '127.0.0.31',
        'POST /deliveries/quote HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"zone":',
      );
      const closed = await Promise.race([
        s.closed,
        new Promise<number>((r) => setTimeout(() => r(-1), 12_000)),
      ]);
      s.destroy();
      expect(closed).toBeGreaterThan(0);
    },
    T,
  );
});

describe('hostile payloads never cause a 5xx and never crash the server', () => {
  const big = (n: number) => 'x'.repeat(n);
  it.each([
    ['10 MB JSON body', () => JSON.stringify({ a: big(10_000_000) }), 413],
    [
      'deeply nested arrays (100k levels, balanced)',
      () => '['.repeat(50_000) + ']'.repeat(50_000),
      400,
    ],
    ['deeply nested objects', () => '{"a":'.repeat(20_000) + '1' + '}'.repeat(20_000), 400],
    ['a JSON array instead of an object', () => '[1,2,3]', 400],
    ['a JSON string', () => '"hello"', 400],
    ['null', () => 'null', 400],
    ['prototype pollution', () => '{"__proto__":{"admin":true},"zone":"A","weightG":1}', 400],
    [
      'constructor pollution',
      () => '{"constructor":{"prototype":{"x":1}},"zone":"A","weightG":1}',
      400,
    ],
    ['NaN / Infinity literals', () => '{"zone":"A","weightG":NaN}', 400],
    ['BOM + trailing garbage', () => '﻿{"zone":"A","weightG":1} trailing', 400],
    [
      'duplicate keys (last one wins, still valid)',
      () => '{"zone":"A","zone":"B","weightG":1}',
      200,
    ],
    ['huge number', () => '{"zone":"A","weightG":1e999}', 400],
    ['unicode escapes with NUL', () => '{"zone":"A","weightG":1,"x":"\\u0000"}', 400],
  ])(
    'quote endpoint: %s',
    async (_n, body, expected) => {
      const a = await world();
      const r = await rawCall(h, '127.0.0.40', 'POST', '/deliveries/quote', {
        token: a.sender.accessToken,
        body: body(),
        timeoutMs: 30_000,
      });
      expect(r.status).toBe(expected);
      expect(h.api.ctx).toBeTruthy();
      expect((await rawCall(h, '127.0.0.41', 'GET', '/health')).status).toBe(200); // still alive
    },
    T,
  );

  it('prototype pollution attempts leave Object.prototype untouched', async () => {
    const a = await world();
    await rawCall(h, '127.0.0.42', 'POST', '/deliveries', {
      token: a.sender.accessToken,
      body: '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
      headers: { 'Idempotency-Key': idemKey() },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it(
    'malformed URLs, odd methods and abusive headers all get 4xx (or a clean close), never 5xx',
    async () => {
      const a = await world();
      const probes: [string, string, Record<string, string>?][] = [
        ['GET', '/tracking/%E0%A4%A'],
        ['GET', '/tracking/%00'],
        ['GET', '/deliveries/%'],
        ['GET', `/deliveries?${'a=1&'.repeat(5000)}`],
        ['GET', '/deliveries?status[]=created&status[__proto__]=x'],
        ['GET', '/..%2f..%2fetc/passwd'],
        ['GET', '//'],
        ['GET', '/%2e%2e/%2e%2e/'],
        ['DELETE', '/deliveries'],
        ['PATCH', '/deliveries/x'],
        ['TRACE', '/health'],
        ['OPTIONS', '/deliveries'],
        ['HEAD', '/health'],
        ['GET', '/health', { 'X-Huge': 'x'.repeat(20_000) }],
        [
          'POST',
          '/deliveries',
          { 'Idempotency-Key': 'a'.repeat(5000), Authorization: `Bearer ${a.sender.accessToken}` },
        ],
        ['GET', '/me', { Authorization: 'Bearer' }],
        ['GET', '/me', { Authorization: 'Basic dXNlcjpwYXNz' }],
        ['GET', '/me', { Authorization: `Bearer ${a.sender.accessToken} extra` }],
        ['GET', '/me', { Authorization: 'Bearer ' + 'a'.repeat(100_000) }],
      ];
      for (const [m, p, hd] of probes) {
        const r = await rawCall(h, '127.0.0.43', m, p, {
          headers: hd,
          body: m === 'POST' ? '{}' : undefined,
        }).catch(() => ({ status: 0 }));
        expect(r.status, `${m} ${p.slice(0, 40)}`).toBeLessThan(500);
      }
      expect((await rawCall(h, '127.0.0.44', 'GET', '/health')).status).toBe(200);
    },
    T,
  );

  it('CORS: only the configured web origin gets Access-Control-Allow-Origin', async () => {
    const allowed = await rawCall(h, '127.0.0.45', 'OPTIONS', '/deliveries', {
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    for (const origin of [
      'http://evil.example',
      'null',
      'http://localhost:3000.evil.example',
      'https://localhost:3000',
    ]) {
      const r = await rawCall(h, '127.0.0.45', 'OPTIONS', '/deliveries', {
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
      expect(r.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });
});

describe('forged and abused credentials', () => {
  const env = testEnv();
  // a session that really exists, so each forged token below fails for its OWN flaw, not for the missing session
  let liveSession = '';
  beforeAll(async () => {
    const a = await world();
    const claims = JSON.parse(
      Buffer.from(a.dispatcher.accessToken.split('.')[1]!, 'base64url').toString(),
    ) as { session_id: string };
    liveSession = claims.session_id;
  });
  const base = () => ({
    session_id: liveSession,
    aud: 'authenticated',
    role: 'authenticated',
    sub: randomUUID(),
    iss: `${env.supabaseUrl}/auth/v1`,
    app_metadata: { role: 'dispatcher' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const me = (token: string) => rawCall(h, '127.0.0.50', 'GET', '/me', { token });

  it('refuses a forged HS256 token even with the RIGHT secret: no live session behind it', async () => {
    // the legacy secret is configured in this test server, so signature, issuer, audience and role all pass
    const { session_id: _omit, ...noSession } = base();
    expect((await me(signJwt(noSession, env.jwtSecret))).status).toBe(401);
    // a made-up session id does not help either
    expect((await me(signJwt({ ...base(), session_id: randomUUID() }, env.jwtSecret))).status).toBe(
      401,
    );
    expect((await me(signJwt({ ...base(), session_id: 'not-a-uuid' }, env.jwtSecret))).status).toBe(
      401,
    );
  });

  it('control: everything valid (right secret AND a live session id) is accepted, so the rejections below are specific', async () => {
    expect((await me(signJwt(base(), env.jwtSecret))).status).toBe(200);
  });

  it('accepts a real GoTrue token', async () => {
    expect((await me((await world()).dispatcher.accessToken)).status).toBe(200);
  });

  it.each([
    ['wrong secret', () => signJwt(base(), 'x'.repeat(40))],
    ['alg none', () => unsignedJwt(base())],
    ['alg NONE (case trick)', () => signJwt(base(), '', { alg: 'NONE', typ: 'JWT' })],
    [
      'expired',
      () => signJwt({ ...base(), exp: Math.floor(Date.now() / 1000) - 3600 }, env.jwtSecret),
    ],
    ['no exp at all', () => signJwt({ ...base(), exp: undefined }, env.jwtSecret)],
    [
      'wrong issuer',
      () => signJwt({ ...base(), iss: 'https://evil.example/auth/v1' }, env.jwtSecret),
    ],
    ['wrong audience', () => signJwt({ ...base(), aud: 'anon' }, env.jwtSecret)],
    ['anon role token', () => signJwt({ ...base(), role: 'anon' }, env.jwtSecret)],
    ['service_role token', () => signJwt({ ...base(), role: 'service_role' }, env.jwtSecret)],
    ['subject is not a uuid', () => signJwt({ ...base(), sub: "1' OR '1'='1" }, env.jwtSecret)],
    ['no subject', () => signJwt({ ...base(), sub: undefined }, env.jwtSecret)],
    [
      'role only in user_metadata',
      () =>
        signJwt(
          { ...base(), app_metadata: {}, user_metadata: { role: 'dispatcher' } },
          env.jwtSecret,
        ),
    ],
    [
      'unknown role "admin"',
      () => signJwt({ ...base(), app_metadata: { role: 'admin' } }, env.jwtSecret),
    ],
    [
      'role as array',
      () => signJwt({ ...base(), app_metadata: { role: ['dispatcher'] } }, env.jwtSecret),
    ],
    ['header typ/alg garbage', () => signJwt(base(), env.jwtSecret, { alg: 'HS512', typ: 'JWT' })],
    [
      'HS256 header, RS256 claims confusion',
      () => signJwt(base(), env.jwtSecret, { alg: 'RS256', typ: 'JWT' }),
    ],
    ['three empty parts', () => '..'],
    ['not base64', () => '!!!.@@@.###'],
    ['one part', () => 'abc'],
    ['five parts', () => 'a.b.c.d.e'],
  ])('rejects: %s', async (_n, make) => {
    const r = await me(make());
    expect([401, 403]).toContain(r.status);
    expect(r.body).toMatchObject({
      error: { code: expect.stringMatching(/UNAUTHENTICATED|FORBIDDEN/) },
    });
  });

  it('rejects an ES256 token signed with the attacker’s own key even if it copies a real key id (algorithm / key confusion)', async () => {
    const a = await world();
    const realHeader = JSON.parse(
      Buffer.from(a.sender.accessToken.split('.')[0]!, 'base64url').toString(),
    );
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({ ...base(), sub: a.dispatcher.user.id })
      .setProtectedHeader({ alg: 'ES256', kid: realHeader.kid, typ: 'JWT' })
      .setIssuedAt()
      .sign(privateKey);
    expect((await me(forged)).status).toBe(401);
  });

  it('rejects HS256 tokens signed with the PUBLIC verification key used as a secret (classic confusion attack)', async () => {
    const jwks = (await (
      await fetch(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`)
    ).json()) as { keys: Record<string, string>[] };
    const publicKey = JSON.stringify(jwks.keys[0]);
    const r = await me(signJwt(base(), publicKey));
    expect(r.status).toBe(401);
    void exportJWK;
  });

  it('a real user token with a tampered payload or signature is rejected', async () => {
    const a = await world();
    const [hd, p, s] = a.courier.accessToken.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.app_metadata.role = 'dispatcher';
    const tampered = `${hd}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect((await me(tampered)).status).toBe(401);
    expect((await me(`${hd}.${p}.${s!.slice(0, -3)}AAA`)).status).toBe(401);
    expect((await call(h, 'GET', '/dispatch/board', { token: tampered })).status).toBe(401);
  });

  it(
    'repeated bad tokens from one IP are throttled like any other traffic',
    async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 150; i++)
        statuses.push(
          (
            await rawCall(h, '127.0.0.51', 'GET', '/me', {
              token: signJwt(base(), 'wrong-secret-wrong-secret'),
            })
          ).status,
        );
      expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(30);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(30);
    },
    T,
  );
});
