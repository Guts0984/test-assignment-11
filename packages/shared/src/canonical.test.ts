import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalJson } from './canonical';

describe('canonicalJson', () => {
  it('is independent of key order, at any depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [1, { z: 1, y: 2 }] } })).toBe(
      canonicalJson({ a: { c: [1, { y: 2, z: 1 }], d: 1 }, b: 1 }),
    );
  });
  it('keeps array order (order is meaningful)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it('different values give different output', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: '1' })).not.toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });
  it('ignores undefined properties like JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
  it('property: shuffling keys never changes the output', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
      }),
    );
  });
});
