import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JWTVerifyGetKey } from 'jose';
import { sql } from 'drizzle-orm';
import { loadEnv, type Env } from './config/env';
import { createAuthVerifier, type AuthVerifier } from './common/auth';
import { AllExceptionsFilter } from './common/exception.filter';
import { AppGuard, type Limiters } from './common/guard';
import {
  createAbuseMiddleware,
  expressErrorHandler,
  installSlowClientGuard,
  requestId,
  requireJsonBody,
} from './common/http-hardening';
import {
  AUTH_VERIFIER,
  CLOCK,
  CTX_TOKEN,
  LIMITERS,
  WORKER,
  STORAGE,
  systemClock,
  type Clock,
} from './common/tokens';
import {
  createWebhookWorker,
  type WebhookWorker,
  type WorkerDeps,
} from './domain/ops/notifications';
import { createDbHandle, createStorageClient } from './db/providers';
import { createInflightGate, createRateLimiter } from './domain/rate-limit';
import type { Ctx } from './domain/ops/common';
import {
  CourierController,
  DeliveriesController,
  DispatchController,
  HealthController,
  NotificationsController,
  TrackingController,
} from './modules/controllers';

export type AppOptions = {
  env?: Env;
  clock?: Clock;
  /** Tests can inject a key set instead of fetching the real JWKS. */
  jwks?: JWTVerifyGetKey;
  verifier?: AuthVerifier;
  storage?: SupabaseClient;
  /** Extra providers/controllers added by other blocks (webhook worker, notification endpoints). */
  extra?: { controllers?: unknown[]; providers?: unknown[] };
  /** Tests inject a deterministic random / resolver for the webhook worker. */
  worker?: Pick<WorkerDeps, 'fetchImpl' | 'random' | 'resolve'>;
};

export type RunningApp = {
  app: INestApplication;
  env: Env;
  ctx: Ctx;
  limiters: Limiters;
  worker: WebhookWorker;
  url: string;
  close: () => Promise<void>;
};

function buildLimiters(env: Env): Limiters {
  const mk = (perMinute: number, burst: number) =>
    createRateLimiter({ capacity: burst, perMinute, maxKeys: env.RATE_LIMIT_MAX_TRACKED_KEYS });
  return {
    ip: mk(env.RATE_LIMIT_IP_PER_MINUTE, Math.max(10, Math.ceil(env.RATE_LIMIT_IP_PER_MINUTE / 2))),
    user: mk(
      env.RATE_LIMIT_USER_PER_MINUTE,
      Math.max(10, Math.ceil(env.RATE_LIMIT_USER_PER_MINUTE / 2)),
    ),
    sensitive: mk(
      env.RATE_LIMIT_SENSITIVE_PER_MINUTE,
      Math.max(5, Math.ceil(env.RATE_LIMIT_SENSITIVE_PER_MINUTE / 2)),
    ),
    tracking: mk(
      env.RATE_LIMIT_TRACKING_PER_MINUTE,
      Math.max(10, Math.ceil(env.RATE_LIMIT_TRACKING_PER_MINUTE / 2)),
    ),
  };
}

export async function createApp(opts: AppOptions = {}): Promise<RunningApp> {
  const env = opts.env ?? loadEnv();
  const clock = opts.clock ?? systemClock;
  const dbHandle = createDbHandle(env);
  const storage = opts.storage ?? createStorageClient(env);
  const limiters = buildLimiters(env);
  const ctx: Ctx = { db: dbHandle.db, env, clock };
  const verifier =
    opts.verifier ??
    createAuthVerifier(env, {
      jwks: opts.jwks,
      sessionExists: async (id) =>
        (await dbHandle.db.execute(sql`select 1 from auth.sessions where id = ${id}`)).length > 0,
    });
  const worker = createWebhookWorker({ ctx, ...(opts.worker ?? {}) });
  const gate = createInflightGate({
    perKey: env.MAX_INFLIGHT_PER_IP,
    global: env.MAX_INFLIGHT_GLOBAL,
  });

  @Module({
    controllers: [
      HealthController,
      DeliveriesController,
      DispatchController,
      CourierController,
      TrackingController,
      NotificationsController,
      ...((opts.extra?.controllers ?? []) as never[]),
    ],
    providers: [
      { provide: CTX_TOKEN, useValue: ctx },
      { provide: CLOCK, useValue: clock },
      { provide: STORAGE, useValue: storage },
      { provide: LIMITERS, useValue: limiters },
      { provide: WORKER, useValue: worker },
      { provide: AUTH_VERIFIER, useValue: verifier },
      { provide: APP_GUARD, useClass: AppGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ...((opts.extra?.providers ?? []) as never[]),
    ],
  })
  class AppModule {}

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.use(requestId);
  // before parsing and authentication: a flood is rejected while it is still cheap
  app.use(createAbuseMiddleware(gate, limiters.ip, clock));
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }),
  );
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: [...env.corsOrigins],
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['Idempotent-Replay', 'X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });
  app.use(requireJsonBody);
  app.use(
    '/courier/photos',
    raw({
      type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'],
      limit: env.PHOTO_MAX_BYTES,
    }),
  );
  app.use(json({ limit: env.BODY_LIMIT_BYTES, strict: true }));

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Courier delivery API')
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, doc);

  await app.init();
  // after init: also catches errors raised by middleware that ran before Nest's router (bad JSON, too large, ...)
  app.getHttpAdapter().getInstance().use(expressErrorHandler);

  await app.listen(env.API_PORT, env.API_HOST);
  const server = app.getHttpServer();
  // slowloris & friends
  server.headersTimeout = env.HEADERS_TIMEOUT_MS;
  server.requestTimeout = env.REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = env.KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 50;
  const stopGuard = installSlowClientGuard(server, env.HEADERS_TIMEOUT_MS, env.REQUEST_TIMEOUT_MS);

  if (env.WEBHOOK_WORKER_ENABLED) worker.start();
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : env.API_PORT;
  return {
    app,
    env,
    ctx,
    limiters,
    worker,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      stopGuard();
      worker.stop();
      await app.close();
      await dbHandle.close();
    },
  };
}
