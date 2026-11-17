import type { schema } from '@courier/db';
import { shortName } from '../tracking';

type D = typeof schema.deliveries.$inferSelect;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What a sender sees about their own delivery. */
export function senderDto(
  d: D,
  extra: { trackingToken?: string; courierName?: string | null } = {},
) {
  return {
    id: d.id,
    number: d.publicNumber,
    status: d.status,
    recipientName: d.recipientName,
    recipientPhone: d.recipientPhone,
    address: d.address,
    zone: d.zone,
    weightG: d.weightG,
    codKop: d.codKop,
    feeKop: d.feeKop,
    codCommissionKop: d.codCommissionKop,
    totalKop: d.totalKop,
    attemptNo: d.attemptNo,
    courierName: extra.courierName ?? null,
    nextAttemptAt: iso(d.nextAttemptAt),
    assignedAt: iso(d.assignedAt),
    pickedUpAt: iso(d.pickedUpAt),
    deliveredAt: iso(d.deliveredAt),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    ...(extra.trackingToken ? { trackingToken: extra.trackingToken } : {}),
  };
}

/** Dispatcher: everything operational. */
export function dispatcherDto(
  d: D,
  extra: { courierName?: string | null; senderCompany?: string | null } = {},
) {
  return {
    ...senderDto(d, { courierName: extra.courierName }),
    senderId: d.senderId,
    senderCompany: extra.senderCompany ?? null,
    courierId: d.courierId,
    handoverBlocked: d.handoverBlocked,
    wrongCodeStreak: d.wrongCodeStreak,
    codCollectedKop: d.codCollectedKop,
  };
}

/** Courier: what is needed to do the job. No prices, no sender, and never the recipient code. */
export function courierDto(d: D) {
  return {
    id: d.id,
    number: d.publicNumber,
    status: d.status,
    recipientName: d.recipientName,
    recipientPhone: d.recipientPhone,
    address: d.address,
    zone: d.zone,
    weightG: d.weightG,
    amountDueKop: d.codKop,
    attemptNo: d.attemptNo,
    assignedAt: iso(d.assignedAt),
    pickedUpAt: iso(d.pickedUpAt),
    handoverBlocked: d.handoverBlocked,
    version: d.version,
  };
}

const SENDER_PAYLOAD_KEYS = ['reason', 'note', 'minutes', 'attemptNo'];

export function eventDto(
  e: typeof schema.deliveryEvents.$inferSelect,
  audience: 'sender' | 'dispatcher',
) {
  const payload =
    audience === 'dispatcher'
      ? e.payload
      : Object.fromEntries(
          Object.entries(e.payload ?? {}).filter(([k]) => SENDER_PAYLOAD_KEYS.includes(k)),
        );
  return {
    id: e.id,
    type: e.type,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    actorRole: e.actorRole,
    deviceTime: iso(e.deviceTime),
    serverTime: e.serverTime.toISOString(),
    payload,
  };
}

export { shortName };
