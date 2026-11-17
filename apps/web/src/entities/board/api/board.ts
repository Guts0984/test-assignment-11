import { api } from '@/shared/api';
import type { DeliveryStatus, Zone } from '@courier/shared';

export type BoardItem = {
  id: string;
  number: string;
  status: DeliveryStatus;
  attemptNo: number;
  recipientName: string;
  weightG: number;
  createdAt: string;
  nextAttemptAt: string | null;
  assignable: boolean;
};
export type BoardCourier = {
  id: string;
  name: string;
  onShift: boolean;
  shiftId: string | null;
  openedAt: string | null;
  active: number;
  limit: number;
};
export type Board = {
  generatedAt: string;
  zones: { zone: Zone; waiting: number; items: BoardItem[] }[];
  couriers: BoardCourier[];
  blocked: {
    id: string;
    number: string;
    courierId: string | null;
    courierName: string | null;
    wrongCodeStreak: number;
  }[];
};
export type ShiftSummary = {
  shiftId: string;
  courierId: string;
  openedAt: string;
  activeDeliveries: number;
  expectedCashKop: number;
};
export type CloseResult = {
  expectedCashKop: number;
  handedCashKop: number;
  discrepancyKop: number;
};
export type Report = {
  period: { from: string; to: string };
  delivered: { count: number; avgAssignToDeliverSeconds: number | null };
  failedAttempts: { total: number; byReason: { reason: string; count: number }[] };
  cashDiscrepancies: {
    shifts: number;
    totalKop: number;
    absoluteTotalKop: number;
    items: {
      shiftId: string;
      courierId: string;
      courierName: string;
      closedAt: string;
      expectedKop: number;
      handedKop: number;
      discrepancyKop: number;
    }[];
  };
};

export const fetchBoard = () => api<Board>('/dispatch/board');
export const fetchShift = (courierId: string) =>
  api<ShiftSummary>(`/dispatch/couriers/${courierId}/shift`);
export const closeShift = (courierId: string, handedCashKop: number) =>
  api<CloseResult>(`/dispatch/couriers/${courierId}/shift/close`, {
    method: 'POST',
    body: { handedCashKop },
  });
export const assign = (deliveryId: string, courierId: string, reassign: boolean) =>
  api(`/dispatch/deliveries/${deliveryId}/assign`, {
    method: 'POST',
    body: { courierId, reassign },
  });
export const unblock = (deliveryId: string) =>
  api(`/dispatch/deliveries/${deliveryId}/unblock`, { method: 'POST' });
export const markReturned = (deliveryId: string) =>
  api(`/dispatch/deliveries/${deliveryId}/returned`, { method: 'POST' });
export const fetchReport = (from: string, to: string) =>
  api<Report>(`/dispatch/report?from=${from}&to=${to}`);
