import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { appError, isAppError } from './errors';
import { sniffImage } from './image';
import { escapeLike, searchIntent } from './search';
import { generateCode, generateToken, safeEqual, sha256Hex, TOKEN_PATTERN } from './secrets';
import { maskPhone, shortName } from './tracking';

describe('secrets', () => {
  it('codes are 6 digits, include leading zeros, and use the whole range', () => {
    const codes = Array.from({ length: 20_000 }, generateCode);
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    const firstDigits = new Map<string, number>();
    for (const c of codes) firstDigits.set(c[0]!, (firstDigits.get(c[0]!) ?? 0) + 1);
    expect(firstDigits.size).toBe(10);
    for (const n of firstDigits.values()) expect(n).toBeGreaterThan(1500); // ~2000 each, no gross bias
  });

  it('tokens are unique, 22 url-safe characters', () => {
    const t = Array.from({ length: 5000 }, generateToken);
    expect(new Set(t).size).toBe(5000);
    for (const x of t) expect(x).toMatch(TOKEN_PATTERN);
  });

  it('safeEqual: equal only for identical strings, whatever their length', () => {
    expect(safeEqual('123456', '123456')).toBe(true);
    for (const [a, b] of [
      ['123456', '123457'],
      ['123456', '12345'],
      ['', '0'],
      ['a', 'A'],
      ['123456', '123456 '],
    ] as const)
      expect(safeEqual(a, b)).toBe(false);
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(safeEqual(a, b)).toBe(a === b);
      }),
    );
  });

  it('sha256Hex matches the known vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('sniffImage (magic bytes, never the declared type)', () => {
  it('recognises jpeg, png and webp', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))?.ext).toBe('jpg');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext).toBe(
      'png',
    );
    expect(
      sniffImage(
        Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP')]),
      )?.ext,
    ).toBe('webp');
  });
  it.each([
    ['empty', Buffer.alloc(0)],
    ['html', Buffer.from('<html>')],
    ['svg', Buffer.from('<svg xmlns=')],
    ['gif', Buffer.from('GIF89a....')],
    ['pdf', Buffer.from('%PDF-1.4')],
    ['truncated jpeg', Buffer.from([0xff, 0xd8])],
    [
      'riff but not webp',
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]),
    ],
    ['exe', Buffer.from('MZ\x90\x00')],
    ['text with a jpeg word', Buffer.from('jpeg')],
  ])('rejects %s', (_n, b) => expect(sniffImage(b)).toBeNull());
  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (u) => {
        sniffImage(Buffer.from(u));
      }),
    );
  });
});

describe('tracking helpers', () => {
  it.each([
    ['+380671234567', '+380 ••••••• 67'],
    ['+48601234567', '+486 •••••• 67'],
    ['+1234567', '+123 • 67'.replace('• ', '•• ')],
    ['123', '•••'],
  ])('maskPhone(%s)', (p, out) => expect(maskPhone(p)).toBe(out));
  it('maskPhone never reveals the middle digits', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\+[1-9]\d{7,14}$/), (p) => {
        const m = maskPhone(p);
        expect(m.replace(/[^\d]/g, '')).toBe(p.slice(1, 4) + p.slice(-2));
      }),
    );
  });
  it.each([
    ['Olena Kovalenko', 'Olena K.'],
    ['  Ivan   Petrenko-Shevchuk  ', 'Ivan P.'],
    ['Madonna', 'Madonna'],
    ['', null],
    [null, null],
    ['A B C', 'A B.'],
  ])('shortName(%j) = %j', (n, out) => expect(shortName(n as string | null)).toBe(out));
});

describe('search intent', () => {
  it.each([
    ['DLV-000123', { number: 123 }],
    ['dlv000123', { number: 123 }],
    ['123', { number: 123 }],
    ['  42  ', { number: 42 }],
    ['+380671234567', { phone: '+380671234567', phonePrefix: '+380671234567' }],
    ['0671234567', { phone: '+380671234567', phonePrefix: '+380671234567' }],
    ['+38067', { phonePrefix: '+38067' }],
    ['067123', { number: 67123, phonePrefix: '+3807123'.replace('7123', '67123') }],
    ['hello', {}],
    ['', {}],
    ["' OR 1=1", {}],
    ['12', { number: 12 }],
    ['DLV-', {}],
  ])('%j', (q, expected) => expect(searchIntent(q)).toEqual(expected));
  it('numbers are capped at 9 digits so they always fit the column', () => {
    expect(searchIntent('9999999999999').number).toBeUndefined();
  });
  it('escapeLike neutralises LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(escapeLike(s).replace(/\\[\\%_]/g, '')).not.toMatch(/[%_\\]/);
      }),
    );
  });
});

describe('app errors', () => {
  it('carry a code, message and details, and are recognised', () => {
    const e = appError('ALREADY_ASSIGNED', 'x', { courierId: '1' });
    expect(isAppError(e)).toBe(true);
    expect(e.appCode).toBe('ALREADY_ASSIGNED');
    expect(e.details).toEqual({ courierId: '1' });
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError('x')).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
