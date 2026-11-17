import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createInflightGate, createRateLimiter, normalizeIp } from './rate-limit';

describe('token bucket', () => {
  const mk = (over: Partial<Parameters<typeof createRateLimiter>[0]> = {}) =>
    createRateLimiter({ capacity: 5, perMinute: 60, maxKeys: 100, ...over });

  it('allows a burst up to capacity, then refuses', () => {
    const l = mk();
    const res = Array.from({ length: 8 }, () => l.take('a', 0).allowed);
    expect(res).toEqual([true, true, true, true, true, false, false, false]);
  });

  it('refills continuously: 1 token per second at 60/min', () => {
    const l = mk();
    for (let i = 0; i < 5; i++) l.take('a', 0);
    expect(l.take('a', 0).allowed).toBe(false);
    expect(l.take('a', 999).allowed).toBe(false);
    expect(l.take('a', 1000).allowed).toBe(true);
    expect(l.take('a', 1000).allowed).toBe(false);
    expect(l.take('a', 3000).allowed).toBe(true);
  });

  it('never refills beyond capacity, however long the pause', () => {
    const l = mk();
    l.take('a', 0);
    const res = Array.from({ length: 8 }, () => l.take('a', 10 * 86_400_000).allowed);
    expect(res.filter(Boolean)).toHaveLength(5);
  });

  it('retryAfterSeconds is a positive integer that really is long enough', () => {
    const l = mk();
    for (let i = 0; i < 5; i++) l.take('a', 0);
    const r = l.take('a', 0);
    expect(r.allowed).toBe(false);
    expect(Number.isInteger(r.retryAfterSeconds)).toBe(true);
    expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(l.take('a', r.retryAfterSeconds * 1000).allowed).toBe(true);
  });

  it('buckets are independent per key', () => {
    const l = mk();
    for (let i = 0; i < 10; i++) l.take('attacker', 0);
    expect(l.take('victim', 0).allowed).toBe(true);
  });

  it('a clock that goes backwards never grants tokens', () => {
    const l = mk();
    for (let i = 0; i < 5; i++) l.take('a', 10_000);
    expect(l.take('a', 0).allowed).toBe(false);
    expect(l.take('a', -999_999).allowed).toBe(false);
  });

  it('a cost larger than the bucket is never allowed and does not corrupt the bucket', () => {
    const l = mk();
    expect(l.take('a', 0, 100).allowed).toBe(false);
    expect(l.take('a', 0, 5).allowed).toBe(true);
  });

  it('memory is bounded: the oldest keys are evicted, recently used ones survive', () => {
    const l = mk({ maxKeys: 10 });
    for (let i = 0; i < 1000; i++) {
      l.take('hot', i);
      l.take(`cold-${i}`, i);
    }
    expect(l.size()).toBeLessThanOrEqual(10);
    // "hot" kept its (depleted-and-refilled) bucket the whole time
    for (let i = 0; i < 5; i++) l.take('hot', 1000);
    expect(l.take('hot', 1000).allowed).toBe(false);
  });

  it('property: over any time window the allowed requests never exceed capacity + rate × time', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 1, maxLength: 300 }),
        (gaps) => {
          const l = mk({ capacity: 10, perMinute: 120 });
          let t = 0;
          let allowed = 0;
          for (const g of gaps) {
            t += g;
            if (l.take('k', t).allowed) allowed++;
          }
          expect(allowed).toBeLessThanOrEqual(10 + (120 / 60_000) * t + 1e-6);
        },
      ),
    );
  });
});

describe('in-flight gate', () => {
  it('caps concurrent requests per key and globally', () => {
    const g = createInflightGate({ perKey: 2, global: 3 });
    const a1 = g.acquire('a')!;
    const a2 = g.acquire('a')!;
    expect(g.acquire('a')).toBeNull();
    const b1 = g.acquire('b')!;
    expect(g.acquire('c')).toBeNull(); // global cap of 3 reached
    a1();
    expect(g.acquire('c')).not.toBeNull();
    a2();
    b1();
  });

  it('release is idempotent and never goes negative', () => {
    const g = createInflightGate({ perKey: 1, global: 10 });
    const r = g.acquire('a')!;
    r();
    r();
    r();
    expect(g.inflight()).toBe(0);
    expect(g.acquire('a')).not.toBeNull();
    expect(g.acquire('a')).toBeNull();
  });

  it('forgets keys that are no longer in flight', () => {
    const g = createInflightGate({ perKey: 1, global: 100 });
    for (let i = 0; i < 1000; i++) g.acquire(`k${i}`)!();
    expect(g.inflight()).toBe(0);
  });
});

describe('normalizeIp', () => {
  it.each([
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['2001:db8::1', '2001:db8::1'],
    [undefined, 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (input, out) => expect(normalizeIp(input)).toBe(out));
});
