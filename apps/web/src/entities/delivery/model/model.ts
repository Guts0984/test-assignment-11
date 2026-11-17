import type { DeliveryStatus, Zone } from '@courier/shared';

export type Address = {
  city: string;
  street: string;
  house: string;
  apartment?: string;
  note?: string;
};

export type DeliveryDto = {
  id: string;
  number: string;
  status: DeliveryStatus;
  recipientName: string;
  recipientPhone: string;
  address: Address;
  zone: Zone;
  weightG: number;
  codKop: number;
  feeKop: number;
  codCommissionKop: number;
  totalKop: number;
  attemptNo: number;
  courierName: string | null;
  nextAttemptAt: string | null;
  assignedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  trackingToken?: string;
  senderCompany?: string | null;
  courierId?: string | null;
  handoverBlocked?: boolean;
  wrongCodeStreak?: number;
};

export type EventDto = {
  id: number;
  type: string;
  fromStatus: DeliveryStatus | null;
  toStatus: DeliveryStatus | null;
  actorRole: string;
  deviceTime: string | null;
  serverTime: string;
  payload: Record<string, unknown>;
};

export type CardDto = {
  delivery: DeliveryDto;
  events: EventDto[];
  photos: { id: string; kind: 'handover' | 'failed'; createdAt: string }[];
};
export type PhotoUrl = { id: string; kind: 'handover' | 'failed'; url: string; expiresAt: string };
export type Quote = { feeKop: number; codCommissionKop: number; totalKop: number };

export const PAGE_SIZE = 20;

export const deliveryKeys = {
  all: ['deliveries'] as const,
  list: (scope: 'sender' | 'dispatcher', query: string) =>
    ['deliveries', 'list', scope, query] as const,
  card: (id: string) => ['deliveries', 'card', id] as const,
  photos: (id: string) => ['deliveries', 'photos', id] as const,
  board: ['board'] as const,
  report: (from: string, to: string) => ['report', from, to] as const,
  notifications: (query: string) => ['notifications', query] as const,
  webhook: ['webhook'] as const,
};
