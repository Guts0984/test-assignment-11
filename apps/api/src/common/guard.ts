import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '@courier/shared';
import { appError } from '../domain/errors';
import { normalizeIp, type RateLimiter } from '../domain/rate-limit';
import { AUTH_VERIFIER, CLOCK, LIMITERS, type Clock } from './tokens';
import type { AuthUser, AuthVerifier } from './auth';

export const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';
export const LIMIT_KEY = 'limitKind';

export type LimitKind = 'sensitive' | 'tracking';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
/** Extra, stricter per-IP / per-user bucket for abuse-prone routes. */
export const Limit = (kind: LimitKind) => SetMetadata(LIMIT_KEY, kind);

export type Limiters = {
  ip: RateLimiter;
  user: RateLimiter;
  sensitive: RateLimiter;
  tracking: RateLimiter;
};

export type AuthedRequest = Request & { user?: AuthUser; requestId?: string };

export const clientIp = (req: Request): string => normalizeIp(req.ip ?? req.socket.remoteAddress);

/** One global guard: authentication → role → per-user limit → per-route limit. */
@Injectable()
export class AppGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH_VERIFIER) private readonly auth: AuthVerifier,
    @Inject(LIMITERS) private readonly limiters: Limiters,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    const limit = this.reflector.getAllAndOverride<LimitKind | undefined>(LIMIT_KEY, targets);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const ip = clientIp(req);
    const now = this.clock.now().getTime();

    if (!isPublic) {
      const header = req.headers.authorization;
      const m = typeof header === 'string' ? /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header) : null;
      if (!m) throw appError('UNAUTHENTICATED', 'Missing bearer token');
      req.user = await this.auth.verify(m[1]!);
      if (roles && roles.length > 0 && !roles.includes(req.user.role)) {
        throw appError('FORBIDDEN', 'Your role cannot do this');
      }
      const u = this.limiters.user.take(`u:${req.user.id}`, now);
      if (!u.allowed)
        throw appError('RATE_LIMITED', 'Too many requests', {
          retryAfterSeconds: u.retryAfterSeconds,
        });
    }

    if (limit) {
      const bucket = this.limiters[limit];
      // per user when logged in, otherwise per IP; a logged-in attacker is also bounded by the IP bucket
      const key = req.user ? `u:${req.user.id}` : `ip:${ip}`;
      const r = bucket.take(key, now);
      if (!r.allowed)
        throw appError('RATE_LIMITED', 'Too many requests', {
          retryAfterSeconds: r.retryAfterSeconds,
        });
      if (req.user) {
        const byIp = bucket.take(`ip:${ip}`, now, 0.25);
        if (!byIp.allowed)
          throw appError('RATE_LIMITED', 'Too many requests', {
            retryAfterSeconds: byIp.retryAfterSeconds,
          });
      }
    }
    return true;
  }
}
