import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  closeShiftSchema,
  assignSchema,
  courierBatchSchema,
  createDeliverySchema,
  deliveryListQuerySchema,
  idempotencyKeySchema,
  normalizePhone,
  quoteInputSchema,
  reportQuerySchema,
} from './schemas';

const id = () => crypto.randomUUID();
const validCreate = {
  recipientName: 'Olena Kovalenko',
  recipientPhone: '+380 (67) 123-45-67',
  address: { city: 'Kyiv', street: 'Khreshchatyk', house: '22', apartment: '5' },
  zone: 'A',
  weightG: 1500,
  codKop: 12_345,
};
const ok = (v: unknown) => createDeliverySchema.safeParse(v);

describe('phone normalisation', () => {
  it.each([
    ['+380671234567', '+380671234567'],
    ['+380 (67) 123-45-67', '+380671234567'],
    ['0671234567', '+380671234567'],
    ['380671234567', '+380671234567'],
    ['+48 601 234 567', '+48601234567'],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each([
    '',
    '+',
    '123',
    'abc',
    '+380abc',
    '067123456',
    '06712345678',
    '+0123456789',
    '++380671234567',
    '+1234567',
    '+1234567890123456',
    '1234567890',
  ])('rejects %j', (input) => expect(normalizePhone(input)).toBeNull());
});

describe('createDeliverySchema', () => {
  it('accepts a valid body and normalises the phone', () => {
    const r = ok(validCreate);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.recipientPhone).toBe('+380671234567');
  });

  it('defaults COD to 0', () => {
    const { codKop: _c, ...rest } = validCreate;
    const r = ok(rest);
    expect(r.success && r.data.codKop).toBe(0);
  });

  it('trims names, and a whitespace-only name is rejected', () => {
    const r = ok({ ...validCreate, recipientName: '  Ivan  ' });
    expect(r.success && r.data.recipientName).toBe('Ivan');
    expect(ok({ ...validCreate, recipientName: '   ' }).success).toBe(false);
    expect(ok({ ...validCreate, recipientName: '' }).success).toBe(false);
  });

  it('accepts unicode names/streets, including emoji and apostrophes', () => {
    expect(ok({ ...validCreate, recipientName: "Оксана Мазепа-О'Нілл 🚚" }).success).toBe(true);
  });

  it.each(['A\nB', 'A\u0000B', 'A\rB', 'A\u007fB', 'A\tB'])(
    'rejects control characters in %j',
    (name) => {
      expect(ok({ ...validCreate, recipientName: name }).success).toBe(false);
    },
  );

  it('length limits are exact', () => {
    expect(ok({ ...validCreate, recipientName: 'x'.repeat(100) }).success).toBe(true);
    expect(ok({ ...validCreate, recipientName: 'x'.repeat(101) }).success).toBe(false);
    expect(
      ok({ ...validCreate, address: { ...validCreate.address, note: 'x'.repeat(201) } }).success,
    ).toBe(false);
  });

  describe('weight boundaries', () => {
    it.each([1, 2, 29_999, 30_000])('accepts %s', (w) =>
      expect(ok({ ...validCreate, weightG: w }).success).toBe(true),
    );
    it.each([0, -1, 30_001, 1.5, NaN, Infinity, '1500', null, undefined])('rejects %s', (w) =>
      expect(ok({ ...validCreate, weightG: w }).success).toBe(false),
    );
  });

  describe('COD boundaries', () => {
    it.each([0, 1, 10_000_000])('accepts %s', (c) =>
      expect(ok({ ...validCreate, codKop: c }).success).toBe(true),
    );
    it.each([-1, 10_000_001, 0.5, NaN, '100', null])('rejects %s', (c) =>
      expect(ok({ ...validCreate, codKop: c }).success).toBe(false),
    );
  });

  it('zone is case sensitive and closed', () => {
    for (const z of ['A', 'B', 'C']) expect(ok({ ...validCreate, zone: z }).success).toBe(true);
    for (const z of ['a', 'D', '', 'AB', null, 1])
      expect(ok({ ...validCreate, zone: z }).success).toBe(false);
  });

  it('mass assignment: server-owned fields are rejected, not silently dropped', () => {
    for (const extra of [
      { feeKop: 1 },
      { totalKop: 1 },
      { status: 'delivered' },
      { senderId: id() },
      { courierId: id() },
      { number: 'DLV-000001' },
      { recipientCode: '000000' },
      { trackingToken: 'x' },
    ]) {
      expect(ok({ ...validCreate, ...extra }).success).toBe(false);
    }
    expect(ok({ ...validCreate, address: { ...validCreate.address, evil: 1 } }).success).toBe(
      false,
    );
  });

  it('prototype pollution payloads are rejected', () => {
    const polluted = JSON.parse('{"__proto__":{"isAdmin":true},"recipientName":"x"}');
    expect(ok(polluted).success).toBe(false);
    const nested = JSON.parse(
      `{"address":{"__proto__":{"x":1},"city":"a","street":"b","house":"1"}}`,
    );
    expect(ok({ ...validCreate, address: nested.address }).success).toBe(false);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it('non-object bodies never throw', () => {
    for (const v of [null, undefined, 1, 'x', [], [1], true]) expect(ok(v).success).toBe(false);
  });
});

describe('quoteInputSchema', () => {
  it('works without cod', () => {
    const r = quoteInputSchema.safeParse({ zone: 'C', weightG: 500 });
    expect(r.success && r.data.codKop).toBe(0);
  });
  it('rejects extra keys', () => {
    expect(quoteInputSchema.safeParse({ zone: 'C', weightG: 500, feeKop: 1 }).success).toBe(false);
  });
});

describe('idempotency key', () => {
  it.each(['abcdefgh', 'a'.repeat(128), 'order-123:retry.1_x'])('accepts %s', (k) =>
    expect(idempotencyKeySchema.safeParse(k).success).toBe(true),
  );
  it.each([
    'short',
    'a'.repeat(129),
    'has space here',
    'new\nline-key',
    'ключ-ключ-ключ',
    '',
    'a b c d e f g',
  ])('rejects %j', (k) => expect(idempotencyKeySchema.safeParse(k).success).toBe(false));
});

describe('courier batch', () => {
  const base = { clientActionId: id(), deliveryId: id(), deviceTime: '2026-05-01T10:00:00+03:00' };
  const pickup = (over = {}) => ({ ...base, clientActionId: id(), type: 'pickup', ...over });
  const deliver = (over = {}) => ({
    ...base,
    clientActionId: id(),
    type: 'deliver',
    code: '123456',
    codCollectedKop: 0,
    photoId: id(),
    ...over,
  });
  const fail = (over = {}) => ({
    ...base,
    clientActionId: id(),
    type: 'fail',
    reason: 'recipient_absent',
    photoId: id(),
    ...over,
  });
  const parse = (actions: unknown[]) => courierBatchSchema.safeParse({ actions });

  it('accepts a mixed batch', () => {
    expect(parse([pickup(), deliver(), fail()]).success).toBe(true);
  });
  it('rejects empty and oversized batches (1..100)', () => {
    expect(parse([]).success).toBe(false);
    expect(parse(Array.from({ length: 100 }, () => pickup())).success).toBe(true);
    expect(parse(Array.from({ length: 101 }, () => pickup())).success).toBe(false);
  });
  it('rejects a duplicate clientActionId inside one batch', () => {
    const a = pickup();
    expect(parse([a, { ...a }]).success).toBe(false);
  });
  it.each(['12345', '1234567', '12345a', '12 456', '123456\n', '١٢٣٤٥٦', '', ' 123456'])(
    'rejects code %j',
    (code) => {
      expect(parse([deliver({ code })]).success).toBe(false);
    },
  );
  it('deliver needs a photo, a code and a collected sum', () => {
    const { photoId: _p, ...noPhoto } = deliver();
    expect(parse([noPhoto]).success).toBe(false);
    const { code: _c, ...noCode } = deliver();
    expect(parse([noCode]).success).toBe(false);
    const { codCollectedKop: _k, ...noSum } = deliver();
    expect(parse([noSum]).success).toBe(false);
  });
  it('fail with reason "other" needs a note; other reasons do not', () => {
    expect(parse([fail({ reason: 'other' })]).success).toBe(false);
    expect(parse([fail({ reason: 'other', note: '   ' })]).success).toBe(false);
    expect(parse([fail({ reason: 'other', note: 'dog at the gate' })]).success).toBe(true);
    expect(parse([fail({ reason: 'no_access' })]).success).toBe(true);
    expect(parse([fail({ reason: 'made_up' })]).success).toBe(false);
  });
  it('rejects unknown action types and extra keys', () => {
    expect(parse([{ ...base, type: 'teleport' }]).success).toBe(false);
    expect(parse([pickup({ status: 'delivered' })]).success).toBe(false);
  });
  it('rejects malformed ids and device times', () => {
    expect(parse([pickup({ deliveryId: 'nope' })]).success).toBe(false);
    expect(parse([pickup({ clientActionId: '1' })]).success).toBe(false);
    expect(parse([pickup({ deviceTime: 'yesterday' })]).success).toBe(false);
    expect(parse([pickup({ deviceTime: '2026-05-01' })]).success).toBe(false);
    expect(parse([pickup({ deviceTime: '2026-05-01T10:00:00Z' })]).success).toBe(true);
  });
});

describe('list and report queries', () => {
  it('coerces query strings and applies defaults', () => {
    const r = deliveryListQuerySchema.safeParse({ page: '2', pageSize: '50' });
    expect(r.success && [r.data.page, r.data.pageSize]).toEqual([2, 50]);
    const d = deliveryListQuerySchema.safeParse({});
    expect(d.success && [d.data.page, d.data.pageSize]).toEqual([1, 20]);
  });
  it('status accepts one value or many', () => {
    const one = deliveryListQuerySchema.safeParse({ status: 'created' });
    expect(one.success && one.data.status).toEqual(['created']);
    const many = deliveryListQuerySchema.safeParse({ status: ['created', 'assigned'] });
    expect(many.success && many.data.status).toEqual(['created', 'assigned']);
    expect(deliveryListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });
  it.each([
    { page: '0' },
    { page: '-1' },
    { page: 'abc' },
    { page: '1.5' },
    { pageSize: '0' },
    { pageSize: '101' },
    { pageSize: '' },
  ])('rejects %j', (q) => expect(deliveryListQuerySchema.safeParse(q).success).toBe(false));
  it('validates dates and ordering', () => {
    expect(deliveryListQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(deliveryListQuerySchema.safeParse({ from: '2026-5-1' }).success).toBe(false);
    expect(
      deliveryListQuerySchema.safeParse({ from: '2026-05-02', to: '2026-05-01' }).success,
    ).toBe(false);
    expect(
      deliveryListQuerySchema.safeParse({ from: '2026-05-01', to: '2026-05-01' }).success,
    ).toBe(true);
  });
  it('search text is bounded and rejects control characters', () => {
    expect(deliveryListQuerySchema.safeParse({ q: 'x'.repeat(65) }).success).toBe(false);
    expect(deliveryListQuerySchema.safeParse({ q: "'; DROP TABLE deliveries;--" }).success).toBe(
      true,
    );
    expect(deliveryListQuerySchema.safeParse({ q: 'a\u0000b' }).success).toBe(false);
  });
  it('report period: required, ordered and at most 366 days', () => {
    expect(reportQuerySchema.safeParse({ from: '2026-01-01' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: '2026-01-02', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(reportQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-01' }).success).toBe(
      true,
    );
    expect(reportQuerySchema.safeParse({ from: '2025-01-01', to: '2025-12-31' }).success).toBe(
      true,
    );
    expect(reportQuerySchema.safeParse({ from: '2024-01-01', to: '2024-12-31' }).success).toBe(
      true,
    ); // leap year, 366 days inclusive
    // inclusive length: 366 days is the maximum
    expect(reportQuerySchema.safeParse({ from: '2025-01-01', to: '2026-01-01' }).success).toBe(
      true,
    );
    expect(reportQuerySchema.safeParse({ from: '2025-01-01', to: '2026-01-02' }).success).toBe(
      false,
    );
    expect(reportQuerySchema.safeParse({ from: '2024-01-01', to: '2025-01-01' }).success).toBe(
      false,
    );
  });
});

describe('small bodies', () => {
  it('close shift needs a non-negative integer sum', () => {
    expect(closeShiftSchema.safeParse({ handedCashKop: 0 }).success).toBe(true);
    for (const v of [-1, 1.5, '5', null, NaN])
      expect(closeShiftSchema.safeParse({ handedCashKop: v }).success).toBe(false);
    expect(closeShiftSchema.safeParse({}).success).toBe(false);
  });
  it('assign defaults reassign=false and needs a uuid', () => {
    const r = assignSchema.safeParse({ courierId: id() });
    expect(r.success && r.data.reassign).toBe(false);
    expect(assignSchema.safeParse({ courierId: 'x' }).success).toBe(false);
  });
});

describe('fuzz: no schema ever throws', () => {
  const schemas = [
    createDeliverySchema,
    quoteInputSchema,
    courierBatchSchema,
    deliveryListQuerySchema,
    reportQuerySchema,
    assignSchema,
    closeShiftSchema,
  ];
  it('arbitrary JSON values only produce success/failure', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        for (const s of schemas) expect(() => s.safeParse(v)).not.toThrow();
      }),
      { numRuns: 1500 },
    );
  });
  it('arbitrary strings for phone parsing never throw', () => {
    fc.assert(
      fc.property(fc.string(), (v) => {
        normalizePhone(v);
      }),
      { numRuns: 3000 },
    );
  });
});
