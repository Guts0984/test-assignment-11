import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ROLES, type Role } from '@courier/shared';
import type { Env } from '../config/env';
import { appError } from '../domain/errors';

export type AuthUser = { id: string; role: Role; email?: string };
export type AuthVerifier = { verify(token: string): Promise<AuthUser> };
export type SessionExists = (sessionId: string) => Promise<boolean>;

const MAX_CACHED_SESSIONS = 20_000;

/**
 * Remembers POSITIVE answers per session id for `ttlSeconds` (0 = no caching). Negatives are never cached, so a
 * revoked session stays revoked. Bounded: the oldest entry is dropped first (Map keeps insertion order).
 */
export function createSessionCheck(
  lookup: SessionExists,
  ttlSeconds: number,
  opts: { maxEntries?: number; now?: () => number } = {},
): SessionExists {
  const max = opts.maxEntries ?? MAX_CACHED_SESSIONS;
  const now = opts.now ?? Date.now;
  const ttlMs = ttlSeconds * 1000;
  const live = new Map<string, number>(); // session id -> expiry (ms)
  return async (id) => {
    if (ttlMs <= 0) return lookup(id);
    const t = now();
    const until = live.get(id);
    if (until !== undefined && until > t) return true;
    live.delete(id);
    if (!(await lookup(id))) return false;
    live.delete(id);
    live.set(id, now() + ttlMs);
    while (live.size > max) live.delete(live.keys().next().value as string);
    return true;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies Supabase JWTs. The algorithm is pinned per key type (never taken on trust from the token):
 * ES256/RS256 against the project's JWKS, HS256 only when the legacy shared secret is configured.
 * `alg: none` and everything else is refused. The token's session must still exist (see below). The role comes from app_metadata only (user_metadata is user-editable).
 */
export function createAuthVerifier(
  env: Env,
  deps: { sessionExists: SessionExists; jwks?: JWTVerifyGetKey },
): AuthVerifier {
  const jwksOverride = deps.jwks;
  const sessionExists = createSessionCheck(deps.sessionExists, env.AUTH_SESSION_CACHE_SECONDS);
  const jwks =
    jwksOverride ??
    createRemoteJWKSet(new URL(`${env.internalSupabaseUrl}/auth/v1/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
  const secret = env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET) : null;
  // exp and sub are mandatory: a token that never expires is not accepted
  const common = {
    issuer: env.issuer,
    audience: 'authenticated',
    clockTolerance: 5,
    requiredClaims: ['exp', 'sub'],
  };

  return {
    async verify(token) {
      try {
        const header = decodeProtectedHeader(token);
        let payload;
        if (header.alg === 'HS256' && secret) {
          ({ payload } = await jwtVerify(token, secret, { ...common, algorithms: ['HS256'] }));
        } else if (header.alg === 'ES256' || header.alg === 'RS256') {
          ({ payload } = await jwtVerify(token, jwks, {
            ...common,
            algorithms: ['ES256', 'RS256'],
          }));
        } else {
          throw new Error('unsupported algorithm');
        }
        const sub = payload.sub;
        const appMeta = (payload as { app_metadata?: { role?: unknown } }).app_metadata;
        const role = appMeta?.role;
        if (typeof sub !== 'string' || !UUID.test(sub)) throw new Error('bad subject');
        if (payload.role !== 'authenticated') throw new Error('not an authenticated user token');
        if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
          throw appError('FORBIDDEN', 'This account has no role');
        }
        // GoTrue deletes the session row on sign-out; without this check a signed-out token would live until `exp`.
        // A token with no session_id (e.g. forged with the legacy secret) is refused: a live session is required.
        const sessionId = (payload as { session_id?: unknown }).session_id;
        if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new Error('no session');
        let alive: boolean;
        try {
          alive = await sessionExists(sessionId.toLowerCase());
        } catch {
          alive = false; // fail closed
        }
        if (!alive) throw new Error('session ended');
        return {
          id: sub.toLowerCase(),
          role: role as Role,
          email: (payload as { email?: string }).email,
        };
      } catch (e) {
        if (e instanceof Error && e.name === 'AppError') throw e;
        throw appError('UNAUTHENTICATED', 'Invalid or expired token');
      }
    },
  };
}
