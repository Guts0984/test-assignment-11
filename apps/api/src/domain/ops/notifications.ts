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
  let loopOn = false;
  let wakeLoop: (() => void) | undefined;

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

  type Outcome = { notification: typeof n.$inferSelect; result: Attempt };

  /** Records one attempt and updates the notification. `lease` is true when the row was claimed by `claim`. */
  async function record(
    id: string,
    r: Attempt,
    manual: boolean,
  ): Promise<typeof n.$inferSelect | null> {
    return ctx.db.transaction(async (tx) => {
      const now = ctx.clock.now();
      const [row] = await tx.select().from(n).where(eq(n.id, id)).for('update');
      if (!row) return null;
      await tx.insert(schema.notificationAttempts).values({
        notificationId: id,
        attemptedAt: now,
        httpStatus: r.httpStatus,
        error: r.error,
        durationMs: r.durationMs,
        manual,
      });
      let patch: Partial<typeof n.$inferInsert> = {};
      if (row.status === 'pending') {
        if (r.ok) {
          patch = {
            status: 'delivered',
            deliveredAt: now,
            attempts: row.attempts + 1,
            lastError: null,
          };
        } else if (manual) {
          patch = { lastError: r.error };
        } else {
          const wait = backoffSeconds(row.attempts + 1, {
            base: ctx.env.WEBHOOK_BACKOFF_BASE_SECONDS,
            max: ctx.env.WEBHOOK_BACKOFF_MAX_SECONDS,
            jitter: random() * 2 - 1,
          });
          patch = {
            attempts: row.attempts + 1,
            lastError: r.error,
            nextAttemptAt: new Date(now.getTime() + wait * 1000),
          };
        }
      }
      if (Object.keys(patch).length === 0) return row;
      const [updated] = await tx.update(n).set(patch).where(eq(n.id, id)).returning();
      return updated!;
    });
  }

  /**
   * Claims a due notification: it must still be pending, due, and the head of its delivery's queue. The claim is a short
   * LEASE (next_attempt_at moves into the future) committed immediately, so no database connection or lock is held while
   * we wait for the receiver, and another worker or API instance will not pick the same row. If this process dies mid
   * request, the lease simply expires and the notification is tried again.
   */
  async function claim(id: string): Promise<typeof n.$inferSelect | null> {
    return ctx.db.transaction(async (tx) => {
      const now = ctx.clock.now();
      const found = await tx.execute<{ id: string }>(sql`
        select id from notifications where id = ${id} and status = 'pending'
          and next_attempt_at <= ${now.toISOString()}::timestamptz and ${headOfQueue(id)}
        for update skip locked`);
      if (found.length === 0) return null;
      const lease = new Date(now.getTime() + ctx.env.WEBHOOK_TIMEOUT_MS * 2 + 5_000);
      const [row] = await tx
        .update(n)
        .set({ nextAttemptAt: lease })
        .where(eq(n.id, id))
        .returning();
      return row!;
    });
  }

  async function send(row: typeof n.$inferSelect): Promise<Attempt> {
    const [hook] = await ctx.db
      .select()
      .from(schema.senderWebhooks)
      .where(eq(schema.senderWebhooks.senderId, row.senderId));
    return hook
      ? post(hook.url, hook.secret, row)
      : { ok: false, httpStatus: null, error: 'no webhook URL configured', durationMs: 0 };
  }

  /** One automatic attempt: claim → send (no transaction open) → record. */
  async function attempt(id: string): Promise<Outcome | null> {
    const row = await claim(id);
    if (!row) return null;
    const result = await send(row);
    const notification = await record(id, result, false);
    return notification ? { notification, result } : null;
  }

  /**
   * A manual resend. Delivered notifications may be sent again at any time (same id). A PENDING one may only be sent
   * when it is the head of its delivery's queue, otherwise "picked_up" could reach the receiver before "assigned".
   */
  async function resend(id: string, senderId: string): Promise<Outcome | { blocked: true } | null> {
    const [row] = await ctx.db
      .select()
      .from(n)
      .where(and(eq(n.id, id), eq(n.senderId, senderId)));
    if (!row) return null;
    if (row.status === 'pending') {
      const head = await ctx.db.execute(sql`select 1 where ${headOfQueue(id)}`);
      if (head.length === 0) return { blocked: true };
    }
    const result = await send(row);
    const notification = await record(id, result, true);
    return notification ? { notification, result } : null;
  }

  const WORKERS = 8;
  /** At most this many notifications of one sender are in flight in this process, so a dead receiver holds 2 of 8 slots. */
  const PER_SENDER_INFLIGHT = 2;
  const BATCH = 50;
  const inflightBySender = new Map<string, number>();

  let wake: (() => void) | null = null;
  let wakeP: Promise<void> = new Promise((r) => (wake = r));
  const notify = () => {
    wake?.();
    wakeP = new Promise((r) => (wake = r));
  };

  type Candidate = { id: string; sender_id: string };

  /**
   * Due candidates: head of their delivery's queue only, oldest first, in a bounded batch served by notifications_due.
   * Rows in flight are leased (next_attempt_at in the future), so they are not due. At most a few rows per sender, so no
   * sender (a dead one with a long backlog) can crowd the others out of the batch.
   * NOTE: an array inside a drizzle sql template expands to a tuple "($1, $2)", not an array, so ids are listed with
   * sql.join (a `= any(${ids}::uuid[])` cast fails with "cannot cast type record to uuid[]").
   */
  async function fetchDue(opts: { senderId?: string; senderIds?: string[] }): Promise<Candidate[]> {
    const now = ctx.clock.now().toISOString();
    const list = (xs: string[]) =>
      sql.join(
        xs.map((x) => sql`${x}::uuid`),
        sql`, `,
      );
    const rows = await ctx.db.execute<Candidate>(sql`
      select id, sender_id from (
        select n.id, n.sender_id, n.next_attempt_at,
               row_number() over (partition by n.sender_id order by n.next_attempt_at, n.id) as rn
        from notifications n
        where n.status = 'pending' and n.next_attempt_at <= ${now}::timestamptz
          ${opts.senderId ? sql`and n.sender_id = ${opts.senderId}::uuid` : sql``}
          ${opts.senderIds ? (opts.senderIds.length ? sql`and n.sender_id in (${list(opts.senderIds)})` : sql`and false`) : sql``}
          and not exists (select 1 from notifications p where p.delivery_id = n.delivery_id and p.seq < n.seq and p.status = 'pending')
      ) x where rn <= ${PER_SENDER_INFLIGHT + 3} order by next_attempt_at, id limit ${BATCH}`);
    return [...rows];
  }

  /**
   * Sends everything that is due, then returns. A pool of WORKERS keeps picking the next due notification as soon as it
   * is free (no lock-step rounds), with at most PER_SENDER_INFLIGHT in flight per sender. Safe to call concurrently and
   * from several processes (the lease claim decides who sends).
   */
  async function tick(
    opts: { senderId?: string; senderIds?: string[] } = {},
  ): Promise<{ attempted: number }> {
    let attempted = 0;
    let buffer: Candidate[] = [];
    const seen = new Set<string>(); // never tried twice in one tick
    let refilling: Promise<void> | null = null;
    let exhausted = false;
    const takeEligible = (): Candidate | null => {
      const i = buffer.findIndex(
        (c) => !seen.has(c.id) && (inflightBySender.get(c.sender_id) ?? 0) < PER_SENDER_INFLIGHT,
      );
      return i < 0 ? null : buffer.splice(i, 1)[0]!;
    };

    async function refill(): Promise<void> {
      buffer = (await fetchDue(opts)).filter((c) => !seen.has(c.id));
      exhausted = buffer.length === 0;
    }

    async function worker(): Promise<void> {
      for (;;) {
        let c = takeEligible();
        while (!c) {
          // coalesce: one refill query at a time, shared by every idle worker
          if (!refilling) refilling = refill().finally(() => (refilling = null));
          await refilling;
          c = takeEligible();
          if (c) break;
          if (exhausted) return; // nothing due (running ones re-check when they finish)
          // due work exists but its senders are at their in-flight cap: wait for a slot
          await Promise.race([wakeP, new Promise((r) => setTimeout(r, 100))]);
        }
        seen.add(c.id);
        inflightBySender.set(c.sender_id, (inflightBySender.get(c.sender_id) ?? 0) + 1);
        try {
          const r = await attempt(c.id).catch(() => null);
          if (r) attempted++;
        } finally {
          const left = (inflightBySender.get(c.sender_id) ?? 1) - 1;
          if (left <= 0) inflightBySender.delete(c.sender_id);
          else inflightBySender.set(c.sender_id, left);
          notify();
        }
      }
    }

    await Promise.all(Array.from({ length: WORKERS }, worker));
    return { attempted };
  }

  return {
    tick,
    attempt,
    resend,
    start() {
      if (loopOn) return;
      loopOn = true;
      void (async () => {
        while (loopOn) {
          const r = await tick().catch(() => ({ attempted: 0 }));
          if (!loopOn) break;
          if (r.attempted === 0)
            await new Promise<void>((res) => {
              timer = setTimeout(res, ctx.env.WEBHOOK_POLL_INTERVAL_MS);
              timer.unref();
              wakeLoop = res;
            });
        }
      })();
    },
    stop() {
      loopOn = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      wakeLoop?.();
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
  const r = await worker.resend(id, senderId);
  if (!r) throw notFound('Notification');
  if ('blocked' in r) {
    throw appError(
      'CONFLICT',
      'An earlier notification for this delivery is still waiting; it must be delivered first',
      { reason: 'earlier_pending' },
    );
  }
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
