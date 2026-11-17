import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

/**
 * Every environment variable the API reads. Non-sensitive values have defaults; secrets and connection
 * strings do not, so a missing secret stops the boot with a readable error instead of running half-configured.
 */
const schema = z.object({
  // secrets / connection (no defaults)
  DATABASE_URL: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),

  // supabase
  SUPABASE_URL: z.url().default('http://127.0.0.1:54321'),
  SUPABASE_INTERNAL_URL: z.url().optional(),
  PHOTO_BUCKET: z.string().min(1).default('delivery-photos'),
  PHOTO_MAX_BYTES: int(5_242_880, 1),
  SIGNED_URL_TTL_SECONDS: int(300, 10),

  // http
  API_PORT: int(4000, 0),
  API_HOST: z.string().default('0.0.0.0'),
  API_CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY: bool.default(false),
  BODY_LIMIT_BYTES: int(262_144, 1024),
  REQUEST_TIMEOUT_MS: int(15_000, 1000),
  HEADERS_TIMEOUT_MS: int(10_000, 1000),
  KEEP_ALIVE_TIMEOUT_MS: int(5_000, 1000),
  DB_POOL_MAX: int(20, 1),
  DB_STATEMENT_TIMEOUT_MS: int(15_000, 100),

  // abuse protection
  RATE_LIMIT_IP_PER_MINUTE: int(1200, 1),
  RATE_LIMIT_USER_PER_MINUTE: int(1200, 1),
  RATE_LIMIT_SENSITIVE_PER_MINUTE: int(120, 1),
  RATE_LIMIT_TRACKING_PER_MINUTE: int(60, 1),
  RATE_LIMIT_MAX_TRACKED_KEYS: int(50_000, 100),
  MAX_INFLIGHT_PER_IP: int(64, 1),
  MAX_INFLIGHT_GLOBAL: int(256, 1),

  // Business limits (8 active deliveries, 45 minutes, 5 wrong codes, 3 attempts, batches of 100) are NOT settings:
  // the database enforces them, so they live in @courier/shared LIMITS and cannot drift from it.
  // business rules
  BUSINESS_TIMEZONE: z.string().default('Europe/Kyiv'),

  // webhooks
  WEBHOOK_WORKER_ENABLED: bool.default(true),
  WEBHOOK_POLL_INTERVAL_MS: int(1000, 50),
  WEBHOOK_TIMEOUT_MS: int(10_000, 100),
  WEBHOOK_BACKOFF_BASE_SECONDS: int(30, 1),
  WEBHOOK_BACKOFF_MAX_SECONDS: int(86_400, 1),
  WEBHOOK_ALLOWED_PRIVATE_HOSTS: z.string().default('sender-stub'),
});

export type Env = Readonly<z.infer<typeof schema>> & {
  readonly corsOrigins: readonly string[];
  readonly issuer: string;
  readonly internalSupabaseUrl: string;
};

/** Parses raw env (default: process.env). Throws one error listing every problem. */
export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const base = e.SUPABASE_URL.replace(/\/+$/, '');
  return Object.freeze({
    ...e,
    corsOrigins: e.API_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    issuer: `${base}/auth/v1`,
    internalSupabaseUrl: (e.SUPABASE_INTERNAL_URL ?? e.SUPABASE_URL).replace(/\/+$/, ''),
  });
}
