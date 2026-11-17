import { describe, expect, it } from 'vitest';
import {
  canCancel,
  canForceHandover,
  canTransition,
  allowedTransitions,
  isTerminal,
  statusAfterFailedAttempt,
  TRANSITIONS,
  type Actor,
} from './status';
import { DELIVERY_STATUSES } from './constants';

const ACTORS: Actor[] = ['sender', 'dispatcher', 'courier', 'system'];

// Written by hand from the assignment's life-cycle rules, independent of the TRANSITIONS table.
const ALLOWED_PAIRS_FOR_TEST = new Set([
  'created>assigned>dispatcher',
  'failed_attempt>assigned>dispatcher',
  'assigned>assigned>dispatcher',
  'assigned>created>system',
  'created>cancelled>sender',
  'assigned>cancelled>sender',
  'assigned>picked_up>courier',
  'picked_up>delivered>courier',
  'picked_up>failed_attempt>courier',
  'failed_attempt>returning>system',
  'returning>returned>dispatcher',
]);

describe('transition matrix (every from × to × actor)', () => {
  for (const from of DELIVERY_STATUSES) {
    for (const to of DELIVERY_STATUSES) {
      for (const actor of ACTORS) {
        const expected = ALLOWED_PAIRS_FOR_TEST.has(`${from}>${to}>${actor}`);
        it(`${actor}: ${from} → ${to} is ${expected ? 'allowed' : 'forbidden'}`, () => {
          expect(canTransition(from, to, actor)).toBe(expected);
        });
      }
    }
  }
});

describe('status machine properties', () => {
  it('terminal statuses have no outgoing transitions for anyone', () => {
    for (const s of DELIVERY_STATUSES.filter(isTerminal)) {
      for (const a of ACTORS) expect(allowedTransitions(s, a)).toEqual([]);
    }
  });

  it('every status is reachable from "created"', () => {
    const seen = new Set(['created']);
    const queue = ['created'];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const t of TRANSITIONS.filter((x) => x.from === cur)) {
        if (!seen.has(t.to)) {
          seen.add(t.to);
          queue.push(t.to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...DELIVERY_STATUSES].sort());
  });

  it('the sender can cancel only before pickup', () => {
    const cancellable = DELIVERY_STATUSES.filter(canCancel);
    expect(cancellable.sort()).toEqual(['assigned', 'created']);
  });

  it('only the system can release an assignment back to the queue', () => {
    for (const a of ACTORS) expect(canTransition('assigned', 'created', a)).toBe(a === 'system');
  });

  it('only a courier can pick up, deliver or fail; nobody else can mark delivered', () => {
    for (const a of ACTORS.filter((x) => x !== 'courier')) {
      expect(canTransition('assigned', 'picked_up', a)).toBe(false);
      expect(canTransition('picked_up', 'delivered', a)).toBe(false);
      expect(canTransition('picked_up', 'failed_attempt', a)).toBe(false);
    }
  });

  it('forced offline handover is never allowed from terminal/returning statuses', () => {
    for (const s of DELIVERY_STATUSES) {
      const blocked = isTerminal(s) || s === 'returning';
      expect(canForceHandover(s)).toBe(!blocked);
    }
  });

  it('3rd failed attempt goes to returning, the first two do not', () => {
    expect([1, 2, 3, 4].map(statusAfterFailedAttempt)).toEqual([
      'failed_attempt',
      'failed_attempt',
      'returning',
      'returning',
    ]);
  });
});
