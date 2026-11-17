import type { DeliveryStatus } from '@courier/shared';

/** "+380671234567" → "+380 •• ••• ••67": the recipient's phone is never shown in full. */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return '•••';
  return `${phone.slice(0, 4)} ${'•'.repeat(Math.max(2, phone.length - 6))} ${phone.slice(-2)}`;
}

export type TrackingView = {
  number: string;
  status: DeliveryStatus;
  attemptNo: number;
  courierName: string | null;
  amountDueKop: number;
  code: string;
  channel: string;
  city: string;
  street: string;
  phoneMasked: string;
  updatedAt: string;
  timeline: { status: DeliveryStatus; at: string }[];
};

/** "Olena Kovalenko" → "Olena K." */
export function shortName(full: string | null): string | null {
  if (!full) return null;
  const t = full.trim();
  const i = t.indexOf(' ');
  if (i < 0) return t;
  const rest = t.slice(i + 1).trim();
  return `${t.slice(0, i)} ${rest.slice(0, 1)}.`;
}
