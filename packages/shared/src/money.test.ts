import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { codCommissionKop, deliveryFeeKop, isMoneyError, quote, startedKilograms } from './money';
import { ZONES } from './constants';

describe('deliveryFeeKop: boundary table', () => {
  const rows: [string, 'A' | 'B' | 'C', number, number][] = [
    ['A 1 g', 'A', 1, 6000],
    ['A exactly 1 kg', 'A', 1000, 6000],
    ['A 1001 g starts the 2nd kg', 'A', 1001, 6800],
    ['A exactly 2 kg', 'A', 2000, 6800],
    ['A 2001 g', 'A', 2001, 7600],
    ['A 30 kg (max)', 'A', 30000, 6000 + 29 * 800],
    ['B 1 g', 'B', 1, 8000],
    ['B 1001 g', 'B', 1001, 8800],
    ['B 30 kg', 'B', 30000, 8000 + 29 * 800],
    ['C 1 g', 'C', 1, 11000],
    ['C 1001 g', 'C', 1001, 11800],
    ['C 29999 g', 'C', 29999, 11000 + 29 * 800],
    ['C 30 kg', 'C', 30000, 11000 + 29 * 800],
  ];
  it.each(rows)('%s', (_n, zone, weight, expected) => {
    expect(deliveryFeeKop(zone, weight)).toBe(expected);
  });

  it.each([0, -1, 30001, 1.5, NaN, Infinity, -Infinity, 1e12])('rejects weight %s', (w) => {
    expect(() => deliveryFeeKop('A', w)).toThrowError();
    try {
      deliveryFeeKop('A', w);
    } catch (e) {
      expect(isMoneyError(e)).toBe(true);
    }
  });

  it('started kilograms never drifts for floating point-ish values', () => {
    expect(startedKilograms(1000)).toBe(1);
    expect(startedKilograms(1001)).toBe(2);
    expect(startedKilograms(3000)).toBe(3);
  });

  it('property: fee is a safe integer, monotonic in weight, steps only at kg boundaries', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), fc.integer({ min: 1, max: 29_999 }), (zone, w) => {
        const a = deliveryFeeKop(zone, w);
        const b = deliveryFeeKop(zone, w + 1);
        expect(Number.isSafeInteger(a)).toBe(true);
        expect(b).toBeGreaterThanOrEqual(a);
        expect(b - a === 0 || (b - a === 800 && w % 1000 === 0)).toBe(true);
      }),
    );
  });
});

describe('codCommissionKop', () => {
  const rows: [string, number, number][] = [
    ['zero COD has no commission', 0, 0],
    ['1 kop COD pays the minimum', 1, 2000],
    ['999.99 UAH is still the minimum', 99_999, 2000],
    ['exactly 1000 UAH = 2% = minimum', 100_000, 2000],
    ['100024 kop: 2000.48 rounds down', 100_024, 2000],
    ['100025 kop: 2000.5 rounds UP (half up)', 100_025, 2001],
    ['100026 kop: 2000.52 rounds up', 100_026, 2001],
    ['100075 kop: 2001.5 rounds up', 100_075, 2002],
    ['1234.50 UAH', 123_450, 2469],
    ['max COD 100 000 UAH', 10_000_000, 200_000],
  ];
  it.each(rows)('%s', (_n, cod, expected) => expect(codCommissionKop(cod)).toBe(expected));

  it.each([-1, 1.5, NaN, Infinity, 10_000_001, Number.MAX_SAFE_INTEGER + 1])('rejects %s', (v) => {
    expect(() => codCommissionKop(v)).toThrowError();
  });

  it('property: equals exact rational rounding (BigInt), min 20 UAH, monotonic', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (cod) => {
        const exact = (BigInt(cod) * 2n * 2n + 100n) / 200n; // round half up of cod*2/100
        const expected = exact < 2000n ? 2000n : exact;
        expect(BigInt(codCommissionKop(cod))).toBe(expected);
        if (cod < 10_000_000) {
          expect(codCommissionKop(cod + 1)).toBeGreaterThanOrEqual(codCommissionKop(cod));
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe('quote', () => {
  it('total = fee + commission; recipient COD is separate', () => {
    const q = quote({ zone: 'B', weightG: 2500, codKop: 250_000 });
    expect(q.feeKop).toBe(8000 + 2 * 800);
    expect(q.codCommissionKop).toBe(5000);
    expect(q.totalKop).toBe(q.feeKop + q.codCommissionKop);
    expect(q.codKop).toBe(250_000);
  });
  it('no COD → total is just the fee', () => {
    expect(quote({ zone: 'A', weightG: 1, codKop: 0 }).totalKop).toBe(6000);
  });
});
