import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  formatDuration,
  formatMoney,
  kopToInput,
  parseMoneyToKop,
  formatWeight,
} from '@/shared/lib';
import { EMPTY_FILTERS, filtersFromParams, filtersToQuery, isCompleteDate } from '@/shared/lib';
import { DELIVERY_STATUSES } from '@courier/shared';
import { parseWeightToGrams, toRequest, EMPTY_FORM } from '@/features/create-delivery';

const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

describe('money formatting', () => {
  it('Ukrainian: 1 234,50 ₴', () => {
    expect(nbsp(formatMoney(123_450, 'uk'))).toBe('1 234,50 ₴');
    expect(nbsp(formatMoney(0, 'uk'))).toBe('0,00 ₴');
    expect(nbsp(formatMoney(5, 'uk'))).toBe('0,05 ₴');
    expect(nbsp(formatMoney(100_000_000, 'uk'))).toBe('1 000 000,00 ₴');
    expect(nbsp(formatMoney(-1_050, 'uk'))).toBe('-10,50 ₴');
  });
  it('English: ₴1,234.50', () => {
    expect(formatMoney(123_450, 'en')).toBe('₴1,234.50');
    expect(formatMoney(99, 'en')).toBe('₴0.99');
  });
  it('property: formatting whole kopecks never shows a wrong digit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), (k) => {
        const digits = nbsp(formatMoney(k, 'uk')).replace(/[^\d,]/g, '');
        expect(digits).toBe(`${Math.trunc(k / 100)},${String(k % 100).padStart(2, '0')}`);
      }),
    );
  });
  it('weight and duration', () => {
    expect(formatWeight(1500, 'uk')).toBe('1,5 кг');
    expect(formatWeight(30_000, 'en')).toBe('30 kg');
    expect(formatDuration(null, 'en')).toBe('–');
    expect(formatDuration(95 * 60, 'en')).toBe('1 h 35 min');
    expect(formatDuration(95 * 60, 'uk')).toBe('1 год 35 хв');
  });
});

describe('parseMoneyToKop', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['1,5', 150],
    ['1.50', 150],
    ['1 234,56', 123_456],
    ['  10  ', 1000],
    ['0,05', 5],
    ['100000', 10_000_000],
    ['007', 700],
  ])('%j → %i', (s, k) => expect(parseMoneyToKop(s)).toBe(k));
  it.each([
    '',
    ' ',
    '-1',
    '1,234',
    '1.2.3',
    'abc',
    '1e3',
    '12,5,0',
    '0x10',
    '١٢٣',
    '1 000 0 0,5x',
    '--5',
    '+5',
    '.5',
    '5.',
  ])('rejects %j', (s) => expect(parseMoneyToKop(s)).toBeNull());
  it('round trips through kopToInput', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (k) => {
        expect(parseMoneyToKop(kopToInput(k))).toBe(k);
      }),
    );
  });
});

describe('weight parsing', () => {
  it.each([
    ['1', 1000],
    ['1,5', 1500],
    ['0.001', 1],
    ['30', 30_000],
    ['0,25', 250],
  ])('%j → %i g', (s, g) => expect(parseWeightToGrams(s)).toBe(g));
  it.each(['', 'x', '1.0005', '-1', '1,,5', '1 kg'])('rejects %j', (s) =>
    expect(parseWeightToGrams(s)).toBeNull(),
  );
});

describe('create-delivery request building', () => {
  const ok = {
    ...EMPTY_FORM,
    recipientName: 'Olena K',
    recipientPhone: '0671234567',
    city: 'Kyiv',
    street: 'Main',
    house: '1',
    weightKg: '1,5',
  };
  it('builds the API body in grams and kopecks, normalising the phone', () => {
    const r = toRequest({ ...ok, cod: '1 234,50', apartment: '5' });
    expect(r).toMatchObject({
      ok: true,
      body: {
        recipientPhone: '+380671234567',
        weightG: 1500,
        codKop: 123_450,
        zone: 'A',
        address: { apartment: '5' },
      },
    });
  });
  it('an empty COD means zero', () => {
    expect(toRequest(ok)).toMatchObject({ ok: true, body: { codKop: 0 } });
  });
  it('reports one issue per field, with the right kind', () => {
    const r = toRequest(EMPTY_FORM);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const byField = Object.fromEntries(r.issues.map((i) => [i.field, i.kind]));
      expect(byField).toMatchObject({
        recipientName: 'required',
        recipientPhone: 'required',
        city: 'required',
        street: 'required',
        house: 'required',
        weightKg: 'required',
      });
      expect(r.issues.map((i) => i.field).sort()).toEqual(
        [...new Set(r.issues.map((i) => i.field))].sort(),
      ); // no duplicates
    }
  });
  it.each([
    ['weight 0', { weightKg: '0' }, 'weightKg', 'weightRange'],
    ['weight 31 kg', { weightKg: '31' }, 'weightKg', 'weightRange'],
    ['weight text', { weightKg: 'heavy' }, 'weightKg', 'invalid'],
    ['COD text', { cod: 'lots' }, 'cod', 'invalid'],
    ['COD over limit', { cod: '100001' }, 'cod', 'codRange'],
    ['bad phone', { recipientPhone: '12' }, 'recipientPhone', 'invalid'],
    ['name too long', { recipientName: 'x'.repeat(101) }, 'recipientName', 'tooLong'],
  ])('%s', (_n, over, field, kind) => {
    const r = toRequest({ ...ok, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.find((i) => i.field === field)?.kind).toBe(kind);
  });
  it('accepts the exact boundaries', () => {
    for (const over of [{ weightKg: '0,001' }, { weightKg: '30' }, { cod: '100000' }])
      expect(toRequest({ ...ok, ...over }).ok).toBe(true);
  });
});

describe('filters ↔ URL', () => {
  const parse = (qs: string) => filtersFromParams(new URLSearchParams(qs));
  it('round trips every combination', () => {
    fc.assert(
      fc.property(
        fc.record({
          q: fc.string({ maxLength: 20 }).map((s) => s.trim()),
          status: fc.subarray([...DELIVERY_STATUSES]),
          from: fc.constantFrom('', '2026-01-01', '2025-12-31'),
          to: fc.constantFrom('', '2026-05-01'),
          page: fc.integer({ min: 1, max: 500 }),
        }),
        (f) => {
          const back = parse(filtersToQuery(f));
          expect(back).toEqual({ ...f, q: f.q });
        },
      ),
    );
  });
  it('drops anything invalid instead of breaking', () => {
    expect(
      parse(
        'status=nope&status=created&from=yesterday&to=2026-13-45x&page=-3&q=' + 'x'.repeat(200),
      ),
    ).toEqual({
      q: 'x'.repeat(64),
      status: ['created'],
      from: '',
      to: '',
      page: 1,
    });
    expect(parse('page=abc')).toEqual(EMPTY_FILTERS);
    expect(parse('page=2.5').page).toBe(1);
  });
  it('clamps the page, rejects impossible dates, drops `to` when it is before `from`', () => {
    expect(parse('page=100000').page).toBe(100_000);
    expect(parse('page=100001').page).toBe(1);
    expect(parse('page=999999').page).toBe(1);
    expect(parse('from=2026-02-30&to=2026-02-28')).toMatchObject({ from: '', to: '2026-02-28' });
    expect(parse('from=2026-03-01&to=2026-02-01')).toMatchObject({ from: '2026-03-01', to: '' });
    expect(parse('from=2026-03-01&to=2026-03-01')).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-01',
    });
    expect(parse('from=0002-10-01').from).toBe('');
  });
  it('isCompleteDate accepts only complete real dates in 1970..2100', () => {
    for (const ok of ['2026-02-28', '2024-02-29', '1970-01-01', '2100-12-31'])
      expect(isCompleteDate(ok), ok).toBe(true);
    for (const bad of [
      '',
      '2026-02',
      '2026-02-30',
      '2025-02-29',
      '0002-10-01',
      '1969-12-31',
      '2101-01-01',
      '2026-13-01',
      '2026-1-1',
      'abcd-ef-gh',
    ])
      expect(isCompleteDate(bad), bad).toBe(false);
  });
  it('omits defaults so URLs stay short', () => {
    expect(filtersToQuery(EMPTY_FILTERS)).toBe('');
    expect(filtersToQuery({ ...EMPTY_FILTERS, page: 2 })).toBe('page=2');
    expect(
      filtersToQuery({ ...EMPTY_FILTERS, status: ['created', 'delivered'], q: ' DLV-1 ' }),
    ).toBe('q=DLV-1&status=created&status=delivered');
  });
});
