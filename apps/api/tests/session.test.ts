import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminClient, anonClient, signIn } from '@courier/db/testing';
import { createAuthVerifier, createSessionCheck } from '../src/common/auth';
import { call, makeActors, startHarness, useHarness, validBody, type Actors } from './harness';

// Cache off: every request asks the database, so revocation is visible immediately.
const h = useHarness({ env: { AUTH_SESSION_CACHE_SECONDS: '0' } });
let actors: Actors;
const world = async () => (actors ??= await makeActors(h.sql));

const me = (token: string) => call(h, 'GET', '/me', { token });
const read = (token: string) => call(h, 'GET', '/deliveries', { token });
const write = (token: string) =>
  call(h, 'POST', '/deliveries/quote', { token, body: { zone: 'A', weightG: 500 } });
const statuses = async (token: string) => [
  (await me(token)).status,
  (await read(token)).status,
  (await write(token)).status,
];
const sessionOf = (token: string) =>
  (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { session_id: string })
    .session_id;
const T = 60_000;

describe('sign-out revokes the API token', () => {
  it('a fresh token works on /me, a read and a write', async () => {
    const a = await world();
    expect(await statuses(a.sender.accessToken)).toEqual([200, 200, 200]);
  });

  it(
    'after a global sign-out the SAME token gets 401 everywhere, other users are unaffected',
    async () => {
      const a = await world();
      const s = await signIn(a.sender2.user.email, a.sender2.user.password);
      expect(await statuses(s.accessToken)).toEqual([200, 200, 200]);
      const { error } = await adminClient().auth.admin.signOut(s.accessToken, 'global');
      expect(error).toBeNull();
      expect(await statuses(s.accessToken)).toEqual([401, 401, 401]);
      // creating a delivery with the dead token is refused too
      const create = await call(h, 'POST', '/deliveries', {
        token: s.accessToken,
        body: validBody(),
        headers: { 'Idempotency-Key': `t-${randomUUID()}` },
      });
      expect(create.status).toBe(401);
      // another user, and the first sender2 session created by makeActors (also global) differ
      expect(await statuses(a.sender.accessToken)).toEqual([200, 200, 200]);
      expect((await me(a.dispatcher.accessToken)).status).toBe(200);
    },
    T,
  );

  it(
    'scope "others" keeps the current session, kills the other one; "local" kills only itself',
    async () => {
      const a = await world();
      const { email, password } = a.courier2.user;
      const s1 = await signIn(email, password);
      const s2 = await signIn(email, password);
      expect(sessionOf(s1.accessToken)).not.toBe(sessionOf(s2.accessToken));
      await adminClient().auth.admin.signOut(s2.accessToken, 'others');
      expect((await me(s1.accessToken)).status).toBe(401);
      expect((await me(s2.accessToken)).status).toBe(200);
      const s3 = await signIn(email, password);
      await adminClient().auth.admin.signOut(s3.accessToken, 'local');
      expect((await me(s3.accessToken)).status).toBe(401);
      expect((await me(s2.accessToken)).status).toBe(200);
      await adminClient().auth.admin.signOut(s2.accessToken, 'global');
      expect((await me(s2.accessToken)).status).toBe(401);
    },
    T,
  );

  it(
    'a refreshed session issues a new token that works; signing out kills it',
    async () => {
      const a = await world();
      const c = anonClient();
      const login = await c.auth.signInWithPassword({
        email: a.courier.user.email,
        password: a.courier.user.password,
      });
      const old = login.data.session!.access_token;
      const refreshed = await c.auth.refreshSession();
      const fresh = refreshed.data.session!.access_token;
      expect(fresh).not.toBe(old);
      expect(sessionOf(fresh)).toBe(sessionOf(old));
      expect((await me(fresh)).status).toBe(200);
      await adminClient().auth.admin.signOut(fresh, 'local');
      expect((await me(fresh)).status).toBe(401);
    },
    T,
  );

  it(
    'a user signing out through their own client (global) loses the token',
    async () => {
      const a = await world();
      const c = anonClient();
      const login = await c.auth.signInWithPassword({
        email: a.dispatcher.user.email,
        password: a.dispatcher.user.password,
      });
      const token = login.data.session!.access_token;
      expect((await me(token)).status).toBe(200);
      expect((await c.auth.signOut({ scope: 'global' })).error).toBeNull();
      expect((await me(token)).status).toBe(401);
    },
    T,
  );
});

describe('with a 1 s cache the revocation takes effect within the TTL', () => {
  it(
    'works, then stops within the TTL after sign-out',
    async () => {
      const h1 = await startHarness({ env: { AUTH_SESSION_CACHE_SECONDS: '1' } });
      const a = await world();
      const s = await signIn(a.sender.user.email, a.sender.user.password);
      expect((await call(h1, 'GET', '/me', { token: s.accessToken })).status).toBe(200);
      await adminClient().auth.admin.signOut(s.accessToken, 'global');
      const started = Date.now();
      let status = 200;
      while (status === 200 && Date.now() - started < 5000) {
        status = (await call(h1, 'GET', '/me', { token: s.accessToken })).status;
        if (status === 200) await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toBe(401);
      expect(Date.now() - started).toBeLessThan(2500);
    },
    T,
  );
});

describe('session check units', () => {
  it('caches positives for the TTL only, never negatives', async () => {
    let t = 0;
    const lookup = vi.fn(async (id: string) => id !== 'dead');
    const check = createSessionCheck(lookup, 10, { now: () => t });
    expect(await check('a')).toBe(true);
    expect(await check('a')).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
    t = 9_999;
    await check('a');
    expect(lookup).toHaveBeenCalledTimes(1);
    t = 10_001;
    await check('a');
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(await check('dead')).toBe(false);
    expect(await check('dead')).toBe(false);
    expect(lookup.mock.calls.filter(([id]) => id === 'dead')).toHaveLength(2);
  });

  it('TTL 0 disables caching', async () => {
    const lookup = vi.fn(async () => true);
    const check = createSessionCheck(lookup, 0);
    await check('a');
    await check('a');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('a revoked session is refused as soon as the cached positive expires', async () => {
    let t = 0;
    let alive = true;
    const check = createSessionCheck(async () => alive, 10, { now: () => t });
    expect(await check('a')).toBe(true);
    alive = false;
    expect(await check('a')).toBe(true); // inside the window
    t = 10_001;
    expect(await check('a')).toBe(false);
  });

  it('the cache is bounded and drops the oldest entries', async () => {
    const lookup = vi.fn(async () => true);
    const check = createSessionCheck(lookup, 60, { maxEntries: 1000 });
    for (let i = 0; i < 3000; i++) await check(`s${i}`);
    expect(lookup).toHaveBeenCalledTimes(3000);
    await check('s2999'); // newest still cached
    expect(lookup).toHaveBeenCalledTimes(3000);
    await check('s0'); // oldest was evicted
    expect(lookup).toHaveBeenCalledTimes(3001);
  });

  it(
    'garbage tokens never reach the database; a failing lookup fails closed',
    async () => {
      const lookup = vi.fn(async () => true);
      const v = createAuthVerifier(h.api.env, { sessionExists: lookup });
      for (const t of ['', 'abc', 'a.b.c', '..', 'x'.repeat(2000)])
        await expect(v.verify(t)).rejects.toMatchObject({ appCode: 'UNAUTHENTICATED' });
      expect(lookup).not.toHaveBeenCalled();

      const a = await world();
      const failing = createAuthVerifier(h.api.env, {
        sessionExists: async () => {
          throw new Error('db down');
        },
      });
      await expect(failing.verify(a.sender.accessToken)).rejects.toMatchObject({
        appCode: 'UNAUTHENTICATED',
      });
      const ok = createAuthVerifier(h.api.env, { sessionExists: lookup });
      // makeActors tokens are valid unless the tests above signed this user out; use a fresh login
      const fresh = await signIn(a.dispatcher.user.email, a.dispatcher.user.password);
      await expect(ok.verify(fresh.accessToken)).resolves.toMatchObject({ role: 'dispatcher' });
      expect(lookup).toHaveBeenCalledTimes(1);
    },
    T,
  );
});
