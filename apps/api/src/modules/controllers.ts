import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  Headers,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { z, type ZodType } from 'zod';
import {
  assignSchema,
  closeShiftSchema,
  courierBatchEnvelopeSchema,
  courierBatchSchema,
  createDeliverySchema,
  deliveryListQuerySchema,
  idempotencyKeySchema,
  photoKindSchema,
  quote,
  quoteInputSchema,
  reportQuerySchema,
  uuidSchema,
  notificationListQuerySchema,
  webhookSettingsSchema,
  type NotificationListQuery,
  type WebhookSettings,
  type CourierBatchEnvelope,
  type CreateDeliveryInput,
  type DeliveryListQuery,
  type ReportQuery,
} from '@courier/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CTX_TOKEN, STORAGE, WORKER } from '../common/tokens';
import { Limit, Public, Roles, type AuthedRequest } from '../common/guard';
import { zod } from '../common/zod.pipe';
import { appError } from '../domain/errors';
import type { Ctx } from '../domain/ops/common';
import {
  cancelDelivery,
  createDelivery,
  getCard,
  listDeliveries,
  signedPhotoUrls,
} from '../domain/ops/deliveries';
import {
  assignDelivery,
  board,
  type BoardOrder,
  closeShift,
  markReturned,
  report,
  shiftSummary,
  unblockHandover,
} from '../domain/ops/dispatch';
import {
  courierToday,
  openShift,
  processBatch,
  rejectedActions,
  uploadPhoto,
} from '../domain/ops/courier';
import { trackingView } from '../domain/ops/tracking';
import {
  getNotification,
  getWebhook,
  listNotifications,
  putWebhook,
  resendNotification,
  type WebhookWorker,
} from '../domain/ops/notifications';

/** Documents a Zod-validated body in Swagger (input side of the schema). */
const docBody = (schema: ZodType) => {
  let js: Record<string, unknown> = {};
  try {
    js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    js = {};
  }
  return ApiBody({ schema: js });
};

/** Only `order` is read; other query keys are ignored for this route. */
const boardQuerySchema = z.object({ order: z.enum(['oldest', 'newest']).default('oldest') });

const idParam = zod(uuidSchema);
const user = (req: AuthedRequest) => req.user!;

@Controller()
export class HealthController {
  constructor(@Inject(CTX_TOKEN) private readonly ctx: Ctx) {}

  @Public()
  @Get('health')
  async health() {
    await this.ctx.db.execute(sql`select 1`);
    return { status: 'ok' };
  }

  @ApiBearerAuth()
  @Get('me')
  me(@Req() req: AuthedRequest) {
    return { id: user(req).id, role: user(req).role, email: user(req).email ?? null };
  }
}

@ApiTags('sender')
@ApiBearerAuth()
@Controller('deliveries')
export class DeliveriesController {
  constructor(
    @Inject(CTX_TOKEN) private readonly ctx: Ctx,
    @Inject(STORAGE) private readonly storage: SupabaseClient,
  ) {}

  /** Price preview. Only the server computes prices; the form shows exactly this. */
  @Roles('sender')
  @HttpCode(200)
  @docBody(quoteInputSchema)
  @Post('quote')
  quote(@Body(zod(quoteInputSchema)) body: z.infer<typeof quoteInputSchema>) {
    return quote(body);
  }

  @Roles('sender')
  @Limit('sensitive')
  @docBody(createDeliverySchema)
  @Post()
  async create(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body(zod(createDeliverySchema)) body: CreateDeliveryInput,
  ) {
    if (key === undefined)
      throw appError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
    const parsed = idempotencyKeySchema.safeParse(key);
    if (!parsed.success) {
      throw appError('VALIDATION_FAILED', 'Invalid Idempotency-Key', {
        fields: { 'Idempotency-Key': parsed.error.issues[0]?.message ?? 'invalid' },
      });
    }
    const r = await createDelivery(this.ctx, user(req).id, parsed.data, body);
    res.status(r.replay ? 200 : 201);
    if (r.replay) res.setHeader('Idempotent-Replay', 'true');
    return r.delivery;
  }

  @Roles('sender')
  @Get()
  list(@Req() req: AuthedRequest, @Query(zod(deliveryListQuerySchema)) q: DeliveryListQuery) {
    return listDeliveries(this.ctx, { id: user(req).id, role: 'sender' }, q);
  }

  @Roles('sender', 'dispatcher')
  @Get(':id')
  card(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    const u = user(req);
    return getCard(this.ctx, { id: u.id, role: u.role as 'sender' | 'dispatcher' }, id);
  }

  @Roles('sender', 'dispatcher')
  @Get(':id/photos')
  photos(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    const u = user(req);
    return signedPhotoUrls(
      this.ctx,
      this.storage,
      { id: u.id, role: u.role as 'sender' | 'dispatcher' },
      id,
    );
  }

  @Roles('sender')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return cancelDelivery(this.ctx, user(req).id, id);
  }
}

@ApiTags('dispatcher')
@ApiBearerAuth()
@Roles('dispatcher')
@Controller('dispatch')
export class DispatchController {
  constructor(@Inject(CTX_TOKEN) private readonly ctx: Ctx) {}

  @Get('board')
  board(@Query(zod(boardQuerySchema)) q: { order: BoardOrder }) {
    return board(this.ctx, q.order);
  }

  @Get('deliveries')
  list(@Req() req: AuthedRequest, @Query(zod(deliveryListQuerySchema)) q: DeliveryListQuery) {
    return listDeliveries(this.ctx, { id: user(req).id, role: 'dispatcher' }, q);
  }

  @HttpCode(200)
  @docBody(assignSchema)
  @Post('deliveries/:id/assign')
  assign(
    @Req() req: AuthedRequest,
    @Param('id', idParam) id: string,
    @Body(zod(assignSchema)) body: z.infer<typeof assignSchema>,
  ) {
    return assignDelivery(this.ctx, user(req).id, id, body);
  }

  @Limit('sensitive')
  @HttpCode(200)
  @Post('deliveries/:id/unblock')
  unblock(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return unblockHandover(this.ctx, user(req).id, id);
  }

  @HttpCode(200)
  @Post('deliveries/:id/returned')
  returned(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return markReturned(this.ctx, user(req).id, id);
  }

  @Get('couriers/:id/shift')
  shift(@Param('id', idParam) id: string) {
    return shiftSummary(this.ctx, id);
  }

  @Limit('sensitive')
  @HttpCode(200)
  @docBody(closeShiftSchema)
  @Post('couriers/:id/shift/close')
  close(
    @Req() req: AuthedRequest,
    @Param('id', idParam) id: string,
    @Body(zod(closeShiftSchema)) body: z.infer<typeof closeShiftSchema>,
  ) {
    return closeShift(this.ctx, user(req).id, id, body.handedCashKop);
  }

  @Get('report')
  report(@Query(zod(reportQuerySchema)) q: ReportQuery) {
    return report(this.ctx, q);
  }
}

@ApiTags('courier')
@ApiBearerAuth()
@Roles('courier')
@Controller('courier')
export class CourierController {
  constructor(
    @Inject(CTX_TOKEN) private readonly ctx: Ctx,
    @Inject(STORAGE) private readonly storage: SupabaseClient,
  ) {}

  @HttpCode(200)
  @Post('shift/open')
  open(@Req() req: AuthedRequest) {
    return openShift(this.ctx, user(req).id);
  }

  @Get('today')
  today(@Req() req: AuthedRequest) {
    return courierToday(this.ctx, user(req).id);
  }

  @HttpCode(200)
  @docBody(courierBatchSchema)
  @Post('actions')
  actions(
    @Req() req: AuthedRequest,
    @Body(zod(courierBatchEnvelopeSchema)) body: CourierBatchEnvelope,
  ) {
    return processBatch(this.ctx, user(req).id, body.actions);
  }

  @Get('actions/rejected')
  rejected(@Req() req: AuthedRequest) {
    return rejectedActions(this.ctx, user(req).id);
  }

  /** Raw image body. Idempotent: the device picks the photo id, a retry never creates a second file. */
  @HttpCode(200)
  @Limit('sensitive')
  @Put('photos/:photoId')
  async photo(
    @Req() req: Request & AuthedRequest,
    @Param('photoId', idParam) photoId: string,
    @Query('deliveryId', zod(uuidSchema)) deliveryId: string,
    @Query('kind', zod(photoKindSchema)) kind: 'handover' | 'failed',
  ) {
    if (!Buffer.isBuffer(req.body)) {
      throw appError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Send the image as the raw request body with an image/* content type',
      );
    }
    return uploadPhoto(this.ctx, this.storage, user(req).id, photoId, deliveryId, kind, req.body);
  }
}

@ApiTags('tracking')
@Controller('tracking')
export class TrackingController {
  constructor(@Inject(CTX_TOKEN) private readonly ctx: Ctx) {}

  @Public()
  @Limit('tracking')
  @Get(':token')
  track(@Param('token') token: string) {
    return trackingView(this.ctx, token);
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Roles('sender')
@Controller()
export class NotificationsController {
  constructor(
    @Inject(CTX_TOKEN) private readonly ctx: Ctx,
    @Inject(WORKER) private readonly worker: WebhookWorker,
  ) {}

  @Get('notifications')
  list(
    @Req() req: AuthedRequest,
    @Query(zod(notificationListQuerySchema)) q: NotificationListQuery,
  ) {
    return listNotifications(this.ctx, user(req).id, q);
  }

  @Get('notifications/:id')
  one(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return getNotification(this.ctx, user(req).id, id);
  }

  /** Sends one attempt right now, with the same notification id, and logs it as a manual attempt. */
  @Limit('sensitive')
  @HttpCode(200)
  @Post('notifications/:id/resend')
  resend(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return resendNotification(this.ctx, this.worker, user(req).id, id);
  }

  @Get('webhook')
  webhook(@Req() req: AuthedRequest) {
    return getWebhook(this.ctx, user(req).id);
  }

  @HttpCode(200)
  @docBody(webhookSettingsSchema)
  @Put('webhook')
  setWebhook(@Req() req: AuthedRequest, @Body(zod(webhookSettingsSchema)) body: WebhookSettings) {
    return putWebhook(this.ctx, this.worker, user(req).id, body);
  }
}
