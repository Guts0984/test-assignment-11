import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ROLES, type Role } from '@courier/shared';
import type { Env } from '../config/env';
import { appError } from '../domain/errors';

export type AuthUser = { id: string; role: Role; email?: string };
export type AuthVerifier = { verify(token: string): Promise<AuthUser> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies Supabase JWTs. The algorithm is pinned per key type (never taken on trust from the token):
 * ES256/RS256 against the project's JWKS, HS256 only when the legacy shared secret is configured.
 * `alg: none` and everything else is refused. The role comes from app_metadata only (user_metadata is user-editable).
 */
export function createAuthVerifier(env: Env, jwksOverride?: JWTVerifyGetKey): AuthVerifier {
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
