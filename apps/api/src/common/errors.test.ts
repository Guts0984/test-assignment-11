import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@courier/shared';
import { appError } from '../domain/errors';
import { toHttpError } from './errors';

const pg = (code: string) => Object.assign(new Error('db'), { code });
const wrapped = (code: string) => Object.assign(new Error('Failed query'), { cause: pg(code) });

describe('toHttpError', () => {
  it('maps domain errors by code, keeping details', () => {
    const r = toHttpError(appError('COURIER_LIMIT_REACHED', 'full', { active: 8 }), 'rid');
    expect(r).toEqual({
      status: 409,
      body: {
        error: {
          code: 'COURIER_LIMIT_REACHED',
          message: 'full',
          details: { active: 8 },
          requestId: 'rid',
        },
      },
    });
  });

  it.each(Object.entries(ERROR_CODES).filter(([c]) => c !== 'INTERNAL'))(
    '%s → HTTP %i',
    (code, status) => {
      expect(toHttpError(appError(code as keyof typeof ERROR_CODES, 'm')).status).toBe(status);
    },
  );

  it.each([
    ['DL001', 409, 'INVALID_STATUS'],
    ['DL002', 409, 'COURIER_LIMIT_REACHED'],
    ['DL003', 409, 'SHIFT_CLOSED'],
    ['DL004', 409, 'CONFLICT'],
    ['23505', 409, 'CONFLICT'],
    ['23503', 409, 'CONFLICT'],
    ['23514', 400, 'VALIDATION_FAILED'],
    ['22P02', 400, 'VALIDATION_FAILED'],
    ['22021', 400, 'VALIDATION_FAILED'],
    ['40P01', 409, 'CONFLICT'],
    ['40001', 409, 'CONFLICT'],
    ['55P03', 409, 'CONFLICT'],
  ])('Postgres %s → %i %s (also when wrapped by the driver)', (code, status, mapped) => {
    for (const e of [pg(code), wrapped(code)]) {
      const r = toHttpError(e);
      expect([r.status, r.body.error.code]).toEqual([status, mapped]);
    }
  });

  it('unknown database errors and plain bugs are 500 with a generic message and no internals', () => {
    for (const e of [
      pg('XX000'),
      new Error('select * from secrets where password = 1'),
      'boom',
      undefined,
      { weird: true },
    ]) {
      const r = toHttpError(e);
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('INTERNAL');
      expect(JSON.stringify(r.body)).not.toMatch(/select|secrets|password|boom/);
    }
  });

  it.each([
    [{ status: 413, type: 'entity.too.large' }, 413, 'PAYLOAD_TOO_LARGE'],
    [{ status: 400, type: 'entity.parse.failed' }, 400, 'INVALID_JSON'],
    [
      Object.assign(new Error('Unexpected token } in JSON at position 4'), { status: 400 }),
      400,
      'INVALID_JSON',
    ],
    [
      Object.assign(new Error('Unexpected end of JSON input'), { status: 400 }),
      400,
      'INVALID_JSON',
    ],
    [{ status: 404 }, 404, 'NOT_FOUND'],
    [{ status: 401 }, 401, 'UNAUTHENTICATED'],
    [{ status: 403 }, 403, 'FORBIDDEN'],
    [{ status: 429 }, 429, 'RATE_LIMITED'],
    [{ status: 415 }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ status: 405 }, 404, 'NOT_FOUND'],
    [{ statusCode: 400 }, 400, 'VALIDATION_FAILED'],
  ])('framework error %j → %i %s', (e, status, code) => {
    const r = toHttpError(e);
    expect([r.status, r.body.error.code]).toEqual([status, code]);
  });

  it('a 4xx the table does not know keeps its own status', () => {
    const r = toHttpError({ status: 418 });
    expect(r.status).toBe(418);
  });

  it('omits requestId when there is none', () => {
    expect('requestId' in toHttpError(appError('NOT_FOUND', 'x')).body.error).toBe(false);
  });
});
