import { lookup } from 'node:dns/promises';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@courier/db';
import { backoffSeconds, type NotificationListQuery, type WebhookSettings } from '@courier/shared';
import { appError } from '../errors';
import { checkWebhookUrl, isPrivateAddress, parseAllowedHosts, webhookHeaders } from '../webhook';
import { notFound, type Ctx } from './common';

const n = schema.notifications;

export type WorkerDeps = {
  ctx: Ctx;
  fetchImpl?: typeof fetch;
  /** 0..1; tests pass () => 0.5 for jitter-free schedules. */
  random?: () => number;
  resolve?: (host: string) => Promise<string[]>;
};

type Attempt = { ok: boolean; httpStatus: number | null; error: string | null; durationMs: number };

const defaultResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((r) => r.address);

export function notificationDto(row: typeof n.$inferSelect) {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    number: (row.payload as { number?: string }).number ?? null,
    seq: row.seq,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.status === 'pending' ? row.nextAttemptAt.toISOString() : null,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    payload: row.payload,
  };
}

export function createWebhookWorker(deps: WorkerDeps) {
  const { ctx } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const random = deps.random ?? Math.random;
  const resolve = deps.resolve ?? defaultResolve;
  const allowed = parseAllowedHosts(ctx.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS);
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  /** SSRF guard: static URL rules, then every resolved address must be public (unless the host is allow-listed). */
  async function assertSafe(rawUrl: string): Promise<void> {
    const v = checkWebhookUrl(rawUrl, allowed);
    if (!v.ok) throw new Error(`blocked: ${v.reason}`);
    const host = v.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (allowed.includes(host)) return;
    const addrs = await resolve(host).catch(() => {
      throw new Error('blocked: host does not resolve');
    });
    if (addrs.length === 0 || addrs.some(isPrivateAddress))
      throw new Error('blocked: resolves to a private address');
  }

  async function post(url: string, secret: string, row: typeof n.$inferSelect): Promise<Attempt> {
    const started = performance.now();
    const body = JSON.stringify(row.payload);
    const ts = Math.floor(ctx.clock.now().getTime() / 1000);
    try {
      await assertSafe(url);
      const res = await doFetch(url, {
        method: 'POST',
        headers: webhookHeaders(secret, row.id, ts, body),
        body,
        redirect: 'manual', // a redirect could point at an internal address
        signal: AbortSignal.timeout(ctx.env.WEBHOOK_TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined);
      const ok = res.status >= 200 && res.status < 300;
      return {
        ok,
        httpStatus: res.status,
        error: ok ? null : `HTTP ${res.status}`,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (e) {
      const name = (e as Error).name;
      const msg =
        name === 'TimeoutError' || name === 'AbortError'
          ? 'timeout'
          : String((e as Error).message ?? e).slice(0, 200);
      return {
        ok: false,
        httpStatus: null,
        error: msg,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  const headOfQueue = (id: string) => sql`not exists (
    select 1 from notifications p where p.delivery_id = (select delivery_id from notifications where id = ${id})
      and p.seq < (select seq from notifications where id = ${id}) and p.status = 'pending')`;

  /**
   * One delivery attempt for one notification. The row stays locked while the request is in flight, so a second
   * worker (or a second API instance) skips it: no double sends. Only the head of a delivery's queue is eligible,
   * which is what keeps `delivered` from overtaking `picked_up`.
   */
  async function attempt(
    id: string,
    opts: { manual: boolean; sender?: string; ignoreSchedule?: boolean },
  ) {
    return ctx.db.transaction(async (tx) => {
      const now = ctx.clock.now();
      const found = await tx.execute<{ id: string }>(sql`
        select id from notifications where id = ${id}
          ${opts.sender ? sql`and sender_id = ${opts.sender}` : sql``}
          ${opts.manual ? sql`` : sql`and status = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz and ${headOfQueue(id)}`}
        for update ${opts.manual ? sql`` : sql`skip locked`}`);
      if (found.length === 0) return null;
      const [row] = await tx.select().from(n).where(eq(n.id, id));
      const [hook] = await tx
        .select()
        .from(schema.senderWebhooks)
        .where(eq(schema.senderWebhooks.senderId, row!.senderId));
      const r: Attempt = hook
        ? await post(hook.url, hook.secret, row!)
        : { ok: false, httpStatus: null, error: 'no webhook URL configured', durationMs: 0 };
      await tx.insert(schema.notificationAttempts).values({
        notificationId: id,
        attemptedAt: now,
        httpStatus: r.httpStatus,
        error: r.error,
        durationMs: r.durationMs,
        manual: opts.manual,
      });
      const canComplete =
        row!.status === 'pending'
          ? (await tx.execute(sql`select 1 where ${headOfQueue(id)}`)).length > 0
          : false;
      let patch: Partial<typeof n.$inferInsert>;
      if (row!.status === 'delivered') {
        patch = {}; // a manual resend of a delivered one only adds an attempt
      } else if (r.ok && (!opts.manual || canComplete)) {
        patch = {
          status: 'delivered',
          deliveredAt: now,
          attempts: row!.attempts + 1,
          lastError: null,
        };
      } else if (opts.manual) {
        patch = { lastError: r.error };
      } else {
        const wait = backoffSeconds(row!.attempts + 1, {
          base: ctx.env.WEBHOOK_BACKOFF_BASE_SECONDS,
          max: ctx.env.WEBHOOK_BACKOFF_MAX_SECONDS,
          jitter: random() * 2 - 1,
        });
        patch = {
          attempts: row!.attempts + 1,
          lastError: r.error,
          nextAttemptAt: new Date(now.getTime() + wait * 1000),
        };
      }
      const [updated] = Object.keys(patch).length
        ? await tx.update(n).set(patch).where(eq(n.id, id)).returning()
        : [row!];
      return { notification: updated!, result: r };
    });
  }

  /** Sends everything that is due. Safe to call concurrently and from several processes. */
  async function tick(opts: { senderId?: string } = {}): Promise<{ attempted: number }> {
    const now = ctx.clock.now().toISOString();
    const due = await ctx.db.execute<{ id: string }>(sql`
      select n.id from notifications n
      where n.status = 'pending' and n.next_attempt_at <= ${now}::timestamptz
        ${opts.senderId ? sql`and n.sender_id = ${opts.senderId}` : sql``}
        and not exists (select 1 from notifications p where p.delivery_id = n.delivery_id and p.seq < n.seq and p.status = 'pending')
      order by n.next_attempt_at limit 50`);
    let attempted = 0;
    const queue = [...due];
    await Promise.all(
      Array.from({ length: Math.min(8, queue.length) }, async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          const r = await attempt(next.id, { manual: false }).catch(() => null);
          if (r) attempted++;
        }
      }),
    );
    return { attempted };
  }

  return {
    tick,
    attempt,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void tick()
          .catch(() => undefined)
          .finally(() => (running = false));
      }, ctx.env.WEBHOOK_POLL_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    assertSafe,
  };
}
export type WebhookWorker = ReturnType<typeof createWebhookWorker>;

// ───────── sender-facing operations ─────────

export async function listNotifications(ctx: Ctx, senderId: string, q: NotificationListQuery) {
  const where = and(
    eq(n.senderId, senderId),
    q.status ? eq(n.status, q.status) : undefined,
    q.deliveryId ? eq(n.deliveryId, q.deliveryId) : undefined,
  );
  const [count] = await ctx.db
    .select({ c: sql<number>`count(*)::int` })
    .from(n)
    .where(where);
  const rows = await ctx.db
    .select()
    .from(n)
    .where(where)
    .orderBy(desc(n.createdAt), desc(n.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return {
    items: rows.map(notificationDto),
    total: count?.c ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function getNotification(ctx: Ctx, senderId: string, id: string) {
  const [row] = await ctx.db
    .select()
    .from(n)
    .where(and(eq(n.id, id), eq(n.senderId, senderId)));
  if (!row) throw notFound('Notification');
  const attempts = await ctx.db
    .select()
    .from(schema.notificationAttempts)
    .where(eq(schema.notificationAttempts.notificationId, id))
    .orderBy(schema.notificationAttempts.id);
  return {
    ...notificationDto(row),
    attemptLog: attempts.map((a) => ({
      id: a.id,
      attemptedAt: a.attemptedAt.toISOString(),
      httpStatus: a.httpStatus,
      error: a.error,
      durationMs: a.durationMs,
      manual: a.manual,
    })),
  };
}

export async function resendNotification(
  ctx: Ctx,
  worker: WebhookWorker,
  senderId: string,
  id: string,
) {
  const r = await worker.attempt(id, { manual: true, sender: senderId });
  if (!r) throw notFound('Notification');
  return {
    notification: notificationDto(r.notification),
    attempt: { ok: r.result.ok, httpStatus: r.result.httpStatus, error: r.result.error },
  };
}

export async function getWebhook(ctx: Ctx, senderId: string) {
  const [h] = await ctx.db
    .select()
    .from(schema.senderWebhooks)
    .where(eq(schema.senderWebhooks.senderId, senderId));
  return h
    ? { url: h.url, secret: h.secret, updatedAt: h.updatedAt.toISOString() }
    : { url: null, secret: null, updatedAt: null };
}

export async function putWebhook(
  ctx: Ctx,
  worker: WebhookWorker,
  senderId: string,
  input: WebhookSettings,
) {
  try {
    await worker.assertSafe(input.url);
  } catch (e) {
    throw appError('VALIDATION_FAILED', 'This webhook URL is not allowed', {
      fields: { url: String((e as Error).message).replace(/^blocked: /, '') },
    });
  }
  const [existing] = await ctx.db
    .select()
    .from(schema.senderWebhooks)
    .where(eq(schema.senderWebhooks.senderId, senderId));
  const secret = input.secret ?? existing?.secret;
  if (!secret)
    throw appError('VALIDATION_FAILED', 'A secret is required the first time', {
      fields: { secret: 'required' },
    });
  await ctx.db
    .insert(schema.senderWebhooks)
    .values({ senderId, url: input.url, secret, updatedAt: ctx.clock.now() })
    .onConflictDoUpdate({
      target: schema.senderWebhooks.senderId,
      set: { url: input.url, secret, updatedAt: ctx.clock.now() },
    });
  return getWebhook(ctx, senderId);
}
