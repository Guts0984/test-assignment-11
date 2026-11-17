/** Token buckets with a bounded key set, and an in-flight gate. Pure state machines over an injected clock. */

type Bucket = { tokens: number; updatedAt: number };

export type RateLimiter = {
  take(key: string, nowMs: number, cost?: number): { allowed: boolean; retryAfterSeconds: number };
  size(): number;
};

export function createRateLimiter(opts: {
  /** Burst size: tokens a full bucket holds. */
  capacity: number;
  perMinute: number;
  maxKeys: number;
}): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = opts.perMinute / 60_000;
  return {
    take(key, nowMs, cost = 1) {
      let b = buckets.get(key);
      if (b) {
        buckets.delete(key); // re-insert below: Map order = recency (cheap LRU)
        const elapsed = Math.max(0, nowMs - b.updatedAt);
        b = { tokens: Math.min(opts.capacity, b.tokens + elapsed * refillPerMs), updatedAt: nowMs };
      } else {
        b = { tokens: opts.capacity, updatedAt: nowMs };
        // An attacker rotating identities can only evict the oldest buckets; memory stays bounded.
        while (buckets.size >= opts.maxKeys) {
          const oldest = buckets.keys().next().value;
          if (oldest === undefined) break;
          buckets.delete(oldest);
        }
      }
      const allowed = b.tokens >= cost;
      if (allowed) b.tokens -= cost;
      buckets.set(key, b);
      const missing = cost - b.tokens;
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(missing / refillPerMs / 1000)),
      };
    },
    size: () => buckets.size,
  };
}

export type InflightGate = {
  /** Returns a release function, or null when the caller is over its share. */
  acquire(key: string): (() => void) | null;
  inflight(): number;
};

/** Caps simultaneous requests per key and globally, so one client cannot occupy every worker and DB slot. */
export function createInflightGate(opts: { perKey: number; global: number }): InflightGate {
  const perKey = new Map<string, number>();
  let total = 0;
  return {
    acquire(key) {
      const n = perKey.get(key) ?? 0;
      if (n >= opts.perKey || total >= opts.global) return null;
      perKey.set(key, n + 1);
      total++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total--;
        const cur = (perKey.get(key) ?? 1) - 1;
        if (cur <= 0) perKey.delete(key);
        else perKey.set(key, cur);
      };
    },
    inflight: () => total,
  };
}

/** `::ffff:1.2.3.4` and `1.2.3.4` are the same client. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
