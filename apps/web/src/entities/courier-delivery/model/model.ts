type Address = { city: string; street: string; house: string; apartment?: string; note?: string };

export type CourierDelivery = {
  id: string;
  number: string;
  status: 'assigned' | 'picked_up';
  recipientName: string;
  recipientPhone: string;
  address: Address;
  zone: string;
  weightG: number;
  amountDueKop: number;
  attemptNo: number;
  assignedAt: string | null;
  pickedUpAt: string | null;
  handoverBlocked: boolean;
};
export type Removed = { deliveryId: string; number: string; reason: string; endedAt: string };
export type Today = {
  shift: { id: string; openedAt: string } | null;
  limit: number;
  deliveries: CourierDelivery[];
  removed: Removed[];
  stale?: boolean;
};
