import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const minimal = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40),
};

describe('loadEnv', () => {
  it('needs only the secrets; everything else has a default', () => {
    const e = loadEnv(minimal);
    expect(e).toMatchObject({
      API_PORT: 4000,
      BUSINESS_TIMEZONE: 'Europe/Kyiv',
      TRUST_PROXY: false,
      WEBHOOK_BACKOFF_MAX_SECONDS: 86_400,
      PHOTO_BUCKET: 'delivery-photos',
      SIGNED_URL_TTL_SECONDS: 300,
    });
    expect(e.corsOrigins).toEqual(['http://localhost:3000']);
    expect(e.issuer).toBe('http://127.0.0.1:54321/auth/v1');
    expect(e.internalSupabaseUrl).toBe('http://127.0.0.1:54321');
  });

  it('AUTH_SESSION_CACHE_SECONDS defaults to 10, accepts 0, refuses negatives and fractions', () => {
    expect(loadEnv(minimal).AUTH_SESSION_CACHE_SECONDS).toBe(10);
    expect(
      loadEnv({ ...minimal, AUTH_SESSION_CACHE_SECONDS: '0' }).AUTH_SESSION_CACHE_SECONDS,
    ).toBe(0);
    for (const bad of ['-1', '1.5', 'abc'])
      expect(() => loadEnv({ ...minimal, AUTH_SESSION_CACHE_SECONDS: bad })).toThrowError(
        /AUTH_SESSION_CACHE_SECONDS/,
      );
  });

  it('lists every missing secret in one error', () => {
    expect(() => loadEnv({})).toThrowError(/DATABASE_URL[\s\S]*SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => loadEnv({ DATABASE_URL: '' })).toThrowError(/DATABASE_URL/);
  });

  it('refuses a too-short service key and a bad URL', () => {
    expect(() => loadEnv({ ...minimal, SUPABASE_SERVICE_ROLE_KEY: 'short' })).toThrowError(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
    expect(() => loadEnv({ ...minimal, SUPABASE_URL: 'not a url' })).toThrowError(/SUPABASE_URL/);
  });

  it.each([
    ['API_PORT', 'abc'],
    ['API_PORT', '-1'],
    ['API_PORT', '1.5'],
    ['RATE_LIMIT_IP_PER_MINUTE', '0'],
    ['TRUST_PROXY', 'yes'],
    ['TRUST_PROXY', '1'],
    ['WEBHOOK_WORKER_ENABLED', 'TRUE'],
    ['DB_POOL_MAX', ''],
    ['BODY_LIMIT_BYTES', '10'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadEnv({ ...minimal, [key]: value })).toThrowError(new RegExp(key));
  });

  it('parses booleans, numbers and lists', () => {
    const e = loadEnv({
      ...minimal,
      TRUST_PROXY: 'true',
      API_PORT: '8080',
      API_CORS_ORIGINS: ' https://a.example , https://b.example,, ',
      SUPABASE_URL: 'https://x.supabase.co/',
      SUPABASE_INTERNAL_URL: 'http://kong:8000/',
    });
    expect(e.TRUST_PROXY).toBe(true);
    expect(e.API_PORT).toBe(8080);
    expect(e.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(e.issuer).toBe('https://x.supabase.co/auth/v1');
    expect(e.internalSupabaseUrl).toBe('http://kong:8000');
  });

  it('the SSRF allow-list ships with the compose stub only, never loopback; hard limits are not settings', () => {
    const e = loadEnv(minimal);
    expect(e.WEBHOOK_ALLOWED_PRIVATE_HOSTS).toBe('sender-stub');
    for (const k of [
      'MAX_ACTIVE_DELIVERIES_PER_COURIER',
      'PICKUP_TIMEOUT_MINUTES',
      'HANDOVER_MAX_WRONG_CODES',
      'MAX_DELIVERY_ATTEMPTS',
      'MAX_BATCH_ACTIONS',
    ]) {
      expect(k in e, `${k} must not be a setting (the database fixes it)`).toBe(false);
    }
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadEnv(minimal))).toBe(true);
  });

  it('every variable of .env.example is understood (no typos, no stale names)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const text = readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8');
    const vars = Object.fromEntries(
      text
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    // docker-compose maps DATABASE_INTERNAL_URL → DATABASE_URL; for the host run, DATABASE_URL is used directly
    const e = loadEnv(vars);
    for (const k of Object.keys(vars)) {
      if (
        k.startsWith('NEXT_PUBLIC_') ||
        k.startsWith('STUB_') ||
        k.startsWith('E2E_') ||
        k.startsWith('WEB_') ||
        k === 'DATABASE_INTERNAL_URL' ||
        k === 'SUPABASE_ANON_KEY'
      )
        continue;
      expect(k in e, `${k} is in .env.example but the API schema does not know it`).toBe(true);
    }
  });
});
