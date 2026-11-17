import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { toHttpError } from './errors';
import { normalizeIp, type InflightGate, type RateLimiter } from '../domain/rate-limit';
import type { Clock } from './tokens';

type Req = Request & { requestId?: string };

export const requestId: RequestHandler = (req: Req, res, next) => {
  const incoming = req.headers['x-request-id'];
  req.requestId =
    typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

function reject(req: Req, res: Response, retryAfterSeconds: number): void {
  const { status, body } = toHttpError(
    Object.assign(new Error('Too many requests'), {
      name: 'AppError',
      appCode: 'RATE_LIMITED',
      details: { retryAfterSeconds },
    }),
    req.requestId,
  );
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(status).json(body);
}

/**
 * Runs before body parsing and authentication, so a flood costs almost nothing:
 * 1. fair share: at most N simultaneous requests per IP (and a global cap), so one client cannot hold every worker;
 * 2. token bucket per IP.
 * The IP is the TCP peer unless TRUST_PROXY is on (then Express resolves X-Forwarded-For from the trusted hop).
 */
export function createAbuseMiddleware(
  gate: InflightGate,
  ipLimiter: RateLimiter,
  clock: Clock,
): RequestHandler {
  return (req: Req, res: Response, next: NextFunction) => {
    const ip = normalizeIp(req.ip ?? req.socket.remoteAddress);
    const release = gate.acquire(ip);
    if (!release) return reject(req, res, 1);
    res.on('close', release);
    const r = ipLimiter.take(`ip:${ip}`, clock.now().getTime());
    if (!r.allowed) return reject(req, res, r.retryAfterSeconds);
    next();
  };
}

/** JSON routes only accept application/json bodies; anything else gets 415 instead of a confusing 400. */
export const requireJsonBody: RequestHandler = (req: Req, res, next) => {
  const hasBody =
    Number(req.headers['content-length'] ?? 0) > 0 ||
    req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const ct = String(req.headers['content-type'] ?? '').toLowerCase();
    const isPhoto = req.path.startsWith('/courier/photos/');
    if (!isPhoto && !ct.startsWith('application/json')) {
      const { status, body } = toHttpError(
        Object.assign(new Error('Unsupported media type'), {
          name: 'AppError',
          appCode: 'UNSUPPORTED_MEDIA_TYPE',
        }),
        req.requestId,
      );
      res.status(status).json(body);
      return;
    }
  }
  next();
};

/** Express error handler for failures that happen before Nest's router (body parsing, malformed JSON, ...). */
export const expressErrorHandler = (
  err: unknown,
  req: Req,
  res: Response,
  _next: NextFunction,
): void => {
  const { status, body } = toHttpError(err, req.requestId);
  res.status(status).json(body);
};

type Tracked = { born: number; headersSeen: boolean; reqStart: number; reqDone: boolean };

/**
 * Slowloris guard. Node only enforces `headersTimeout` / `requestTimeout` every 30 s, which is far too coarse: a
 * client that opens thousands of sockets and trickles bytes would hold them for that long. This sweeps every half
 * second and destroys sockets that have not delivered a complete request head (or body) in time.
 */
export function installSlowClientGuard(
  server: import('node:http').Server,
  headersTimeoutMs: number,
  requestTimeoutMs: number,
): () => void {
  const sockets = new Map<import('node:net').Socket, Tracked>();
  server.on('connection', (socket) => {
    sockets.set(socket, { born: Date.now(), headersSeen: false, reqStart: 0, reqDone: true });
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('request', (req) => {
    const t = sockets.get(req.socket);
    if (!t) return;
    t.headersSeen = true;
    t.reqStart = Date.now();
    t.reqDone = false;
    req.on('end', () => {
      t.reqDone = true;
    });
    // keep-alive: the next request on this socket gets a fresh head window
    req.on('close', () => {
      t.headersSeen = false;
      t.born = Date.now();
    });
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [socket, t] of sockets) {
      if (!t.headersSeen && now - t.born > headersTimeoutMs) socket.destroy();
      else if (t.headersSeen && !t.reqDone && now - t.reqStart > requestTimeoutMs) socket.destroy();
    }
  }, 500);
  timer.unref();
  return () => clearInterval(timer);
}
