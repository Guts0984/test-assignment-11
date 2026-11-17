import { type DeliveryStatus, type Role, LIMITS } from './constants';

export type Actor = Role | 'system';

export type Transition = {
  from: DeliveryStatus;
  to: DeliveryStatus;
  actors: readonly Actor[];
  note: string;
};

/** The documented transition table. The DB trigger enforces the same pairs (see migrations). */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: 'created',
    to: 'assigned',
    actors: ['dispatcher'],
    note: 'open shift, fewer than 8 active',
  },
  {
    from: 'failed_attempt',
    to: 'assigned',
    actors: ['dispatcher'],
    note: 'not before next_attempt_at',
  },
  { from: 'assigned', to: 'assigned', actors: ['dispatcher'], note: 'explicit reassignment' },
  { from: 'assigned', to: 'created', actors: ['system'], note: 'not picked up within 45 minutes' },
  { from: 'created', to: 'cancelled', actors: ['sender'], note: 'own delivery, before pickup' },
  { from: 'assigned', to: 'cancelled', actors: ['sender'], note: 'own delivery, before pickup' },
  { from: 'assigned', to: 'picked_up', actors: ['courier'], note: 'the assigned courier' },
  { from: 'picked_up', to: 'delivered', actors: ['courier'], note: 'correct code, matching COD' },
  { from: 'picked_up', to: 'failed_attempt', actors: ['courier'], note: 'reason and photo' },
  {
    from: 'failed_attempt',
    to: 'returning',
    actors: ['system'],
    note: 'after the 3rd failed attempt',
  },
  { from: 'returning', to: 'returned', actors: ['dispatcher'], note: 'parcel handed back' },
];

export function canTransition(from: DeliveryStatus, to: DeliveryStatus, actor: Actor): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor));
}

export function allowedTransitions(from: DeliveryStatus, actor: Actor): DeliveryStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && t.actors.includes(actor)).map((t) => t.to);
}

export const TERMINAL_STATUSES: readonly DeliveryStatus[] = ['delivered', 'returned', 'cancelled'];

export function isTerminal(status: DeliveryStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Invariant 8: a handover with the correct code is always counted, even when the delivery
 * was released or reassigned while the courier was offline. These are the statuses it may start from.
 * Terminal statuses and `returning`/`returned` are not eligible.
 */
export const OFFLINE_HANDOVER_FROM: readonly DeliveryStatus[] = [
  'created',
  'assigned',
  'picked_up',
  'failed_attempt',
];

export function canForceHandover(from: DeliveryStatus): boolean {
  return OFFLINE_HANDOVER_FROM.includes(from);
}

/** Where a delivery goes after a failed attempt number `attemptNo` (1-based). */
export function statusAfterFailedAttempt(attemptNo: number): 'failed_attempt' | 'returning' {
  return attemptNo >= LIMITS.maxAttempts ? 'returning' : 'failed_attempt';
}

/** Cancellation is allowed only before pickup. */
export function canCancel(status: DeliveryStatus): boolean {
  return canTransition(status, 'cancelled', 'sender');
}
