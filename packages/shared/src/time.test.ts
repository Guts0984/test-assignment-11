import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { localDate, localParts, nextAttemptAt } from './time';

const iso = (d: Date) => d.toISOString();

describe('nextAttemptAt = next Kyiv midnight', () => {
  it('ordinary winter day (UTC+2)', () => {
    expect(iso(nextAttemptAt(new Date('2026-01-15T10:00:00Z')))).toBe('2026-01-15T22:00:00.000Z');
  });
  it('ordinary summer day (UTC+3)', () => {
    expect(iso(nextAttemptAt(new Date('2026-07-15T10:00:00Z')))).toBe('2026-07-15T21:00:00.000Z');
  });
  it('the day before the spring DST jump', () => {
    // 28 Mar 2026 12:00 Kyiv (+2) → midnight of 29 Mar is still +2
    expect(iso(nextAttemptAt(new Date('2026-03-28T10:00:00Z')))).toBe('2026-03-28T22:00:00.000Z');
  });
  it('on the spring DST day (clocks jump 03:00 → 04:00)', () => {
    // 29 Mar 13:00 Kyiv (+3) → 30 Mar 00:00 is +3
    expect(iso(nextAttemptAt(new Date('2026-03-29T10:00:00Z')))).toBe('2026-03-29T21:00:00.000Z');
  });
  it('the day before the autumn DST change', () => {
    expect(iso(nextAttemptAt(new Date('2026-10-24T12:00:00Z')))).toBe('2026-10-24T21:00:00.000Z');
  });
  it('on the autumn DST day (clocks go back 04:00 → 03:00)', () => {
    expect(iso(nextAttemptAt(new Date('2026-10-25T12:00:00Z')))).toBe('2026-10-25T22:00:00.000Z');
  });
  it('one second before and exactly at local midnight', () => {
    expect(iso(nextAttemptAt(new Date('2026-06-10T20:59:59Z')))).toBe('2026-06-10T21:00:00.000Z');
    expect(iso(nextAttemptAt(new Date('2026-06-10T21:00:00Z')))).toBe('2026-06-11T21:00:00.000Z');
  });
  it('year and month rollover', () => {
    expect(iso(nextAttemptAt(new Date('2026-12-31T15:00:00Z')))).toBe('2026-12-31T22:00:00.000Z');
    expect(localDate(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01-01');
  });

  it('property: strictly in the future, within 25 h, and exactly 00:00:00 local', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2035-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        (d) => {
          const next = nextAttemptAt(d);
          expect(next.getTime()).toBeGreaterThan(d.getTime());
          expect(next.getTime() - d.getTime()).toBeLessThanOrEqual(25 * 3600 * 1000);
          const p = localParts(next);
          expect([p.h, p.mi, p.s]).toEqual([0, 0, 0]);
        },
      ),
      { numRuns: 3000 },
    );
  });
});
