import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { backoffSeconds } from './backoff';

describe('backoffSeconds', () => {
  it('doubles from 30 s', () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffSeconds(n))).toEqual([30, 60, 120, 240, 480]);
  });
  it('is capped at exactly 24 h', () => {
    expect(backoffSeconds(12)).toBe(61_440); // 30 * 2^11, still below the cap
    expect(backoffSeconds(13)).toBe(86_400); // 30 * 2^12 = 122 880 → capped
    expect(backoffSeconds(14)).toBe(86_400);
    expect(backoffSeconds(1000)).toBe(86_400);
    expect(backoffSeconds(Number.MAX_SAFE_INTEGER)).toBe(86_400);
  });
  it('jitter never exceeds the 24 h cap or goes below 1 s', () => {
    expect(backoffSeconds(1000, { jitter: 1 })).toBe(86_400);
    expect(backoffSeconds(1, { jitter: -1 })).toBe(24);
    expect(backoffSeconds(1, { base: 1, jitter: -1 })).toBeGreaterThanOrEqual(1);
  });
  it.each([0, -5, NaN, Infinity, -Infinity])('survives hostile attempt %s', (n) => {
    const v = backoffSeconds(n);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(1);
    expect(v).toBeLessThanOrEqual(86_400);
  });
  it('survives hostile jitter', () => {
    for (const j of [NaN, Infinity, -Infinity, 100]) {
      const v = backoffSeconds(3, { jitter: j });
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeLessThanOrEqual(86_400);
    }
  });
  it('property: finite, within bounds, non-decreasing without jitter', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), (n) => {
        const a = backoffSeconds(n);
        expect(a).toBeGreaterThanOrEqual(30);
        expect(a).toBeLessThanOrEqual(86_400);
        expect(backoffSeconds(n + 1)).toBeGreaterThanOrEqual(a);
      }),
    );
  });
});
