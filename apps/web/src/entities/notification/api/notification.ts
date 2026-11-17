import { api, type ListPage } from '@/shared/api';

export type NotificationDto = {
  id: string;
  deliveryId: string;
  number: string | null;
  seq: number;
  eventType: string;
  status: 'pending' | 'delivered';
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
  attemptLog?: {
    id: number;
    attemptedAt: string;
    httpStatus: number | null;
    error: string | null;
    durationMs: number | null;
    manual: boolean;
  }[];
};
export type WebhookDto = { url: string | null; secret: string | null; updatedAt: string | null };

export const fetchNotifications = (query: string) =>
  api<ListPage<NotificationDto>>(`/notifications?${query}`);
export const fetchNotification = (id: string) => api<NotificationDto>(`/notifications/${id}`);
export const resend = (id: string) =>
  api<{ attempt: { ok: boolean; httpStatus: number | null; error: string | null } }>(
    `/notifications/${id}/resend`,
    { method: 'POST' },
  );
export const fetchWebhook = () => api<WebhookDto>('/webhook');
export const saveWebhook = (b: { url: string; secret?: string }) =>
  api<WebhookDto>('/webhook', { method: 'PUT', body: b });
