import { afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSql, type Sql } from '@courier/db';
import {
  createProfiled,
  openShift,
  quickCourier,
  signIn,
  testEnv,
  type Session,
  type TestUser,
} from '@courier/db/testing';
import { createApp, type RunningApp } from '../src/app';
import { loadEnv, type Env } from '../src/config/env';
import type { Clock } from '../src/common/tokens';

export type TestClock = Clock & { set(d: Date): void; advance(ms: number): void };

/** Follows real time (the database stamps rows with real time too) plus an adjustable offset. */
export function createTestClock(): TestClock {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    set: (d) => void (offset = d.getTime() - Date.now()),
    advance: (ms) => void (offset += ms),
  };
}

export function apiEnv(over: Record<string, string> = {}): Env {
  const e = testEnv();
  return loadEnv({
    DATABASE_URL: e.databaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: e.serviceRoleKey,
    SUPABASE_JWT_SECRET: e.jwtSecret,
    SUPABASE_URL: e.supabaseUrl,
    API_PORT: '0',
    API_HOST: '127.0.0.1',
    WEBHOOK_WORKER_ENABLED: 'false',
    // functional tests hammer one IP; the abuse suite starts its own server with the real limits
    RATE_LIMIT_IP_PER_MINUTE: '10000000',
    RATE_LIMIT_USER_PER_MINUTE: '10000000',
    RATE_LIMIT_SENSITIVE_PER_MINUTE: '10000000',
    RATE_LIMIT_TRACKING_PER_MINUTE: '10000000',
    MAX_INFLIGHT_PER_IP: '1000',
    MAX_INFLIGHT_GLOBAL: '2000',
    ...over,
  });
}

export type Harness = {
  api: RunningApp;
  sql: Sql;
  clock: TestClock;
  url: string;
};

/** Registers beforeAll/afterAll that start and stop the real API; returns a handle filled in once started. */
export function useHarness(over: Parameters<typeof startHarness>[0] = {}): Harness {
  const h = {} as Harness;
  beforeAll(async () => {
    Object.assign(h, await startHarness(over));
  }, 120_000);
  return h;
}

/** Starts the real API on a random port against the real local database. Closed automatically. */
export async function startHarness(
  over: {
    env?: Record<string, string>;
    clock?: TestClock;
    extra?: Parameters<typeof createApp>[0];
  } = {},
): Promise<Harness> {
  const clock = over.clock ?? createTestClock();
  const sql = createSql({ url: testEnv().databaseUrl, max: 30 });
  const api = await createApp({ env: apiEnv(over.env), clock, ...(over.extra ?? {}) });
  const handle: Harness = { api, sql, clock, url: api.url };
  afterAll(async () => {
    await api.close();
    await sql.end({ timeout: 5 });
  });
  return handle;
}

export type Resp<T = unknown> = { status: number; body: T; headers: Headers };

export async function call<T = unknown>(
  h: { url: string },
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    raw?: string | Buffer | Uint8Array;
    contentType?: string;
  } = {},
): Promise<Resp<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | Buffer | Uint8Array | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = opts.contentType ?? 'application/json';
  }
  const res = await fetch(`${h.url}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export type Actors = {
  sender: Session & { user: TestUser };
  sender2: Session & { user: TestUser };
  dispatcher: Session & { user: TestUser };
  courier: Session & { user: TestUser };
  courier2: Session & { user: TestUser };
};

/** Fresh users, so tests never share state with the seed or each other. Couriers get an open shift. */
export async function makeActors(sql: Sql, opts: { shifts?: boolean } = {}): Promise<Actors> {
  const mk = async (role: 'sender' | 'dispatcher' | 'courier') => {
    const user = await createProfiled(sql, role);
    const s = await signIn(user.email, user.password);
    return { ...s, user };
  };
  const a: Actors = {
    sender: await mk('sender'),
    sender2: await mk('sender'),
    dispatcher: await mk('dispatcher'),
    courier: await mk('courier'),
    courier2: await mk('courier'),
  };
  if (opts.shifts ?? true) {
    await openShift(sql, a.courier.user.id);
    await openShift(sql, a.courier2.user.id);
  }
  return a;
}

export const validBody = (over: Record<string, unknown> = {}) => ({
  recipientName: 'Olena Kovalenko',
  recipientPhone: '+380671234567',
  address: { city: 'Kyiv', street: 'Khreshchatyk', house: '22', apartment: '5' },
  zone: 'A',
  weightG: 1500,
  codKop: 0,
  ...over,
});

export const idemKey = () => `test-${randomUUID()}`;

export type DeliveryDto = {
  id: string;
  number: string;
  status: string;
  trackingToken: string;
  totalKop: number;
  feeKop: number;
  codKop: number;
  codCommissionKop: number;
  attemptNo: number;
  [k: string]: unknown;
};

export async function createViaApi(
  h: Harness,
  token: string,
  over: Record<string, unknown> = {},
): Promise<DeliveryDto> {
  const r = await call<DeliveryDto>(h, 'POST', '/deliveries', {
    token,
    body: validBody(over),
    headers: { 'Idempotency-Key': idemKey() },
  });
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const codeOf = async (sql: Sql, deliveryId: string): Promise<string> => {
  const [r] = await sql<
    { recipient_code: string }[]
  >`select recipient_code from public.delivery_secrets where delivery_id = ${deliveryId}`;
  return r!.recipient_code;
};

/** 1x1 JPEG: starts with the JPEG magic bytes, unique per call so hashes differ. */
export const jpeg = (salt: string = randomUUID()): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(salt)]);

export async function uploadPhotoVia(
  h: Harness,
  token: string,
  deliveryId: string,
  kind: 'handover' | 'failed',
  photoId = randomUUID(),
  bytes = jpeg(),
) {
  const r = await call(
    h,
    'PUT',
    `/courier/photos/${photoId}?deliveryId=${deliveryId}&kind=${kind}`,
    { token, raw: bytes, contentType: 'image/jpeg' },
  );
  return { photoId, bytes, res: r };
}

export { quickCourier };

export const assign = (
  h: { url: string },
  token: string,
  deliveryId: string,
  courierId: string,
  reassign = false,
) =>
  call<{
    delivery?: DeliveryDto;
    error?: { code: string; details?: Record<string, unknown>; message: string };
  }>(h, 'POST', `/dispatch/deliveries/${deliveryId}/assign`, {
    token,
    body: { courierId, reassign },
  });

const nowIso = () => new Date().toISOString();
export const act = {
  pickup: (deliveryId: string) => ({
    type: 'pickup' as const,
    clientActionId: randomUUID(),
    deliveryId,
    deviceTime: nowIso(),
  }),
  deliver: (deliveryId: string, code: string, codCollectedKop: number, photoId: string) => ({
    type: 'deliver' as const,
    clientActionId: randomUUID(),
    deliveryId,
    deviceTime: nowIso(),
    code,
    codCollectedKop,
    photoId,
  }),
  fail: (deliveryId: string, photoId: string, reason = 'recipient_absent', note?: string) => ({
    type: 'fail' as const,
    clientActionId: randomUUID(),
    deliveryId,
    deviceTime: nowIso(),
    reason,
    photoId,
    ...(note ? { note } : {}),
  }),
};

export type ActionResult = {
  clientActionId: string;
  result: 'applied' | 'rejected';
  deliveryId: string;
  status?: string;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  duplicate?: boolean;
  noop?: boolean;
};

export const sendActions = (h: { url: string }, token: string, actions: unknown[]) =>
  call<{ results: ActionResult[] }>(h, 'POST', '/courier/actions', { token, body: { actions } });

export const statusOf = async (sql: Sql, id: string): Promise<string> => {
  const [r] = await sql<
    { status: string }[]
  >`select status from public.deliveries where id = ${id}`;
  return r!.status;
};

/** Sender creates, dispatcher assigns to `courier`, courier picks up. Returns what is needed to hand over. */
export async function pickedUp(
  h: Harness,
  a: Actors,
  over: Record<string, unknown> = {},
  who: 'courier' | 'courier2' = 'courier',
) {
  const d = await createViaApi(h, a.sender.accessToken, over);
  const as = await assign(h, a.dispatcher.accessToken, d.id, a[who].user.id);
  if (as.status !== 200) throw new Error(`assign failed ${as.status} ${JSON.stringify(as.body)}`);
  const pk = await sendActions(h, a[who].accessToken, [act.pickup(d.id)]);
  if (pk.body.results[0]?.result !== 'applied')
    throw new Error(`pickup failed ${JSON.stringify(pk.body)}`);
  return { d, code: await codeOf(h.sql, d.id) };
}

export async function handoverReady(h: Harness, a: Actors, over: Record<string, unknown> = {}) {
  const base = await pickedUp(h, a, over);
  const photo = await uploadPhotoVia(h, a.courier.accessToken, base.d.id, 'handover');
  return { ...base, photoId: photo.photoId };
}

// ───────── raw HTTP from a chosen SOURCE IP (127.0.0.x are all local on Linux) ─────────
import http from 'node:http';
import net from 'node:net';

export type RawResp = {
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
  ms: number;
};

const agents = new Map<string, http.Agent>();
const agentFor = (ip: string) => {
  let a = agents.get(ip);
  if (!a) {
    a = new http.Agent({ keepAlive: false, localAddress: ip, maxSockets: 512 });
    agents.set(ip, a);
  }
  return a;
};

export function rawCall(
  h: { url: string },
  ip: string,
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: string | Buffer;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<RawResp> {
  const u = new URL(h.url);
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined && !headers['Content-Type'])
      headers['Content-Type'] = 'application/json';
    const req = http.request(
      {
        host: u.hostname,
        port: Number(u.port),
        method,
        path,
        headers,
        agent: agentFor(ip),
        timeout: opts.timeoutMs ?? 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            /* text */
          }
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
            ms: performance.now() - started,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Opens a socket from `ip` and sends `payload` without ever finishing the request. Resolves with the close time. */
export function slowSocket(
  h: { url: string },
  ip: string,
  payload: string,
): { closed: Promise<number>; destroy: () => void } {
  const u = new URL(h.url);
  const started = Date.now();
  const s = net.connect({ host: u.hostname, port: Number(u.port), localAddress: ip });
  s.on('connect', () => s.write(payload));
  s.on('error', () => undefined);
  const closed = new Promise<number>((resolve) =>
    s.on('close', () => resolve(Date.now() - started)),
  );
  return { closed, destroy: () => s.destroy() };
}

export const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]!;
};
