import { describe, expect, it } from 'vitest';
import { validateDeliver } from './validate';

describe('validateDeliver', () => {
  it('accepts a 6-digit code, an amount up to 100 000 ₴ and a photo', () => {
    expect(validateDeliver({ code: '123456', amount: '100000' }, true)).toEqual({
      ok: true,
      code: '123456',
      kop: 10_000_000,
    });
    expect(validateDeliver({ code: '000001', amount: '' }, true)).toEqual({
      ok: true,
      code: '000001',
      kop: 0,
    });
  });
  it('refuses an amount the server would refuse (so one bad value cannot sink an offline batch)', () => {
    for (const amount of ['100001', '100000,01', '99999999999999999']) {
      expect(validateDeliver({ code: '123456', amount }, true)).toMatchObject({
        ok: false,
        errors: { amount: 'invalid' },
      });
    }
  });
  it.each([
    ['', 'required'],
    ['12345', 'code'],
    ['1234567', 'code'],
    ['12345a', 'code'],
    [' 12345', 'code'],
  ])('code %j → %s', (code, kind) => {
    expect(validateDeliver({ code, amount: '' }, true)).toMatchObject({
      ok: false,
      errors: { code: kind },
    });
  });
  it('needs a photo', () => {
    expect(validateDeliver({ code: '123456', amount: '' }, false)).toMatchObject({
      ok: false,
      errors: { photo: 'required' },
    });
  });
});
