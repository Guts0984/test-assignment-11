import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { CourierAction } from '@courier/shared';
import {
  applyResults,
  dismissRejected,
  enqueue,
  markUploaded,
  overlayStatus,
  pending,
  planSync,
  rejectByPhoto,
  MAX_BATCH,
  type ServerResult,
  type SyncState,
} from './engine';

const uuid = () => crypto.randomUUID();
const empty: SyncState = { queue: [], photos: [] };
const bytes = () => new Uint8Array([0xff, 0xd8, 0xff]).buffer;
const pickup = (deliveryId = uuid()): CourierAction => ({
  type: 'pickup',
  clientActionId: uuid(),
  deliveryId,
  deviceTime: new Date().toISOString(),
});
const deliver = (
  deliveryId: string,
  photoId = uuid(),
): Extract<CourierAction, { type: 'deliver' }> => ({
  type: 'deliver',
  clientActionId: uuid(),
  deliveryId,
  deviceTime: new Date().toISOString(),
  code: '123456',
  codCollectedKop: 0,
  photoId,
});
const fail = (deliveryId: string, photoId = uuid()): Extract<CourierAction, { type: 'fail' }> => ({
  type: 'fail',
  clientActionId: uuid(),
  deliveryId,
  deviceTime: new Date().toISOString(),
  reason: 'no_access',
  photoId,
});

const add = (s: SyncState, a: CourierAction, withPhoto = true): SyncState =>
  enqueue(
    s,
    { clientActionId: a.clientActionId, action: a, number: 'DLV-1' },
    a.type !== 'pickup' && withPhoto
      ? {
          id: a.photoId,
          deliveryId: a.deliveryId,
          kind: a.type === 'deliver' ? 'handover' : 'failed',
          data: bytes(),
          contentType: 'image/jpeg',
        }
      : undefined,
  );

describe('planSync', () => {
  it('sends pending actions in the order they were made', () => {
    let s = empty;
    const a = pickup(),
      b = pickup(),
      c = pickup();
    for (const x of [b, a, c]) s = add(s, x);
    expect(planSync(s).batch.map((q) => q.clientActionId)).toEqual(
      [b, a, c].map((x) => x.clientActionId),
    );
  });

  it('uploads a photo first and holds the action back until it is uploaded', () => {
    const d = deliver(uuid());
    let s = add(empty, d);
    expect(planSync(s)).toMatchObject({ uploads: [{ id: d.photoId }], batch: [] });
    s = markUploaded(s, d.photoId);
    expect(planSync(s)).toMatchObject({
      uploads: [],
      batch: [{ clientActionId: d.clientActionId }],
    });
  });

  it('an action never overtakes an earlier one that is still waiting for its photo', () => {
    const id = uuid();
    const p = pickup(id);
    const d = deliver(id);
    const later = pickup();
    let s = add(add(add(empty, p), d), later);
    expect(planSync(s).batch.map((q) => q.action.type)).toEqual(['pickup']); // deliver blocks `later`
    s = markUploaded(s, d.photoId);
    expect(planSync(s).batch.map((q) => q.clientActionId)).toEqual(
      [p, d, later].map((x) => x.clientActionId),
    );
  });

  it('an action whose photo record is gone is held back forever rather than sent without it', () => {
    const d = deliver(uuid());
    const s = add(empty, d, false);
    expect(planSync(s)).toEqual({ uploads: [], batch: [] });
  });

  it('batches are capped at 100 and the rest follows', () => {
    let s = empty;
    for (let i = 0; i < 250; i++) s = add(s, pickup());
    expect(planSync(s).batch).toHaveLength(MAX_BATCH);
  });

  it('rejected actions are not sent again; the same photo is uploaded once', () => {
    const id = uuid();
    const photoId = uuid();
    let s = add(add(empty, deliver(id, photoId), true), fail(id, photoId), false);
    expect(planSync(s).uploads).toHaveLength(1);
    s = {
      ...s,
      queue: s.queue.map((q, i) => (i === 0 ? { ...q, status: 'rejected' as const } : q)),
    };
    expect(planSync(s).batch.map((q) => q.action.type)).not.toContain('deliver');
  });
});

describe('applyResults', () => {
  const applied = (a: CourierAction): ServerResult => ({
    clientActionId: a.clientActionId,
    result: 'applied',
  });
  const rejected = (a: CourierAction): ServerResult => ({
    clientActionId: a.clientActionId,
    result: 'rejected',
    code: 'WRONG_CODE',
    message: 'Wrong code',
  });

  it('removes applied actions and their photos; keeps rejected ones with the reason', () => {
    const d = deliver(uuid());
    const p = pickup();
    let s = markUploaded(add(add(empty, d), p), d.photoId);
    s = applyResults(s, [applied(p), rejected(d)]);
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]).toMatchObject({
      status: 'rejected',
      reject: { code: 'WRONG_CODE', message: 'Wrong code' },
    });
    expect(s.photos).toHaveLength(1); // the rejected delivery keeps its photo (the courier may retry)
    s = applyResults(s, []);
    expect(s.queue).toHaveLength(1);
  });

  it('a delivered photo is dropped once its action is applied', () => {
    const d = deliver(uuid());
    const s = applyResults(markUploaded(add(empty, d), d.photoId), [applied(d)]);
    expect(s).toEqual({ queue: [], photos: [] });
  });

  it('ignores answers for unknown ids, and never touches an already rejected action', () => {
    const a = pickup();
    let s = applyResults(add(empty, a), [rejected(a)]);
    s = applyResults(s, [applied(a), { clientActionId: uuid(), result: 'applied' }]);
    expect(s.queue[0]).toMatchObject({ status: 'rejected' });
  });

  it('dismissRejected removes only that rejection (and its photo when nothing else needs it)', () => {
    const d = deliver(uuid());
    let s = applyResults(markUploaded(add(empty, d), d.photoId), [
      { clientActionId: d.clientActionId, result: 'rejected', code: 'X', message: 'y' },
    ]);
    expect(dismissRejected(s, uuid())).toEqual(s);
    s = dismissRejected(s, d.clientActionId);
    expect(s).toEqual({ queue: [], photos: [] });
  });

  it('rejectByPhoto turns every action that needs a dead photo into a visible rejection', () => {
    const id = uuid();
    const photoId = uuid();
    const s = rejectByPhoto(add(add(empty, deliver(id, photoId)), pickup()), photoId, {
      code: 'NOT_FOUND',
      message: 'no',
    });
    expect(s.queue.map((q) => q.status)).toEqual(['rejected', 'pending']);
  });
});

describe('overlayStatus: what the courier sees while offline', () => {
  it('a waiting pickup already shows as picked up; deliver/fail as their results; counts what is waiting', () => {
    const id = uuid();
    let s = add(empty, pickup(id));
    expect(overlayStatus('assigned', id, s.queue)).toEqual({ status: 'picked_up', waiting: 1 });
    s = add(s, deliver(id));
    expect(overlayStatus('assigned', id, s.queue)).toEqual({ status: 'delivered', waiting: 2 });
    expect(overlayStatus('assigned', uuid(), s.queue)).toEqual({ status: 'assigned', waiting: 0 });
    expect(overlayStatus('picked_up', id, add(empty, fail(id)).queue)).toEqual({
      status: 'failed_attempt',
      waiting: 1,
    });
  });
  it('rejected actions do not change what is shown', () => {
    const id = uuid();
    const p = pickup(id);
    const s = applyResults(add(empty, p), [
      { clientActionId: p.clientActionId, result: 'rejected', code: 'REASSIGNED', message: 'x' },
    ]);
    expect(s.queue[0]!.status).toBe('rejected');
    expect(overlayStatus('assigned', id, s.queue)).toEqual({ status: 'assigned', waiting: 0 });
  });
});

// A tiny fake server with the same idempotency contract as the real API.
function fakeServer() {
  const stored = new Map<string, ServerResult>();
  const appliedCount = new Map<string, number>();
  return {
    stored,
    appliedCount,
    handle(actions: CourierAction[]): ServerResult[] {
      return actions.map((a) => {
        const prev = stored.get(a.clientActionId);
        if (prev) return { ...prev, duplicate: true };
        // rule: every 7th action is "rejected", the rest applied (deterministic from the id)
        const reject = parseInt(a.clientActionId.slice(0, 2), 16) % 7 === 0;
        const r: ServerResult = reject
          ? {
              clientActionId: a.clientActionId,
              result: 'rejected',
              code: 'WRONG_CODE',
              message: 'm',
            }
          : { clientActionId: a.clientActionId, result: 'applied' };
        stored.set(a.clientActionId, r);
        if (r.result === 'applied')
          appliedCount.set(a.clientActionId, (appliedCount.get(a.clientActionId) ?? 0) + 1);
        return r;
      });
    },
  };
}

describe('property: random connectivity never loses or duplicates an action', () => {
  it('any interleaving of offline work, lost responses and retries ends with every action applied or rejected exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant('add' as const),
            fc.constant('sync-ok' as const),
            fc.constant('sync-lost-response' as const),
            fc.constant('sync-offline' as const),
            fc.constant('sync-twice' as const),
          ),
          { minLength: 1, maxLength: 60 },
        ),
        (steps) => {
          const server = fakeServer();
          let s = empty;
          const made: string[] = [];
          const sync = (mode: 'ok' | 'lost' | 'offline' | 'twice') => {
            // upload everything (photos are always reachable in this model)
            for (const u of planSync(s).uploads) s = markUploaded(s, u.id);
            const { batch } = planSync(s);
            if (batch.length === 0 || mode === 'offline') return;
            const answers = server.handle(batch.map((b) => b.action));
            if (mode === 'twice') server.handle(batch.map((b) => b.action)); // the same batch sent again, in parallel
            if (mode === 'lost') return; // the server processed it but the response never arrived
            s = applyResults(s, answers);
          };
          for (const step of steps) {
            if (step === 'add') {
              const a = Math.random() < 0.5 ? pickup() : deliver(uuid());
              s = add(s, a);
              made.push(a.clientActionId);
            } else
              sync(
                step === 'sync-ok'
                  ? 'ok'
                  : step === 'sync-lost-response'
                    ? 'lost'
                    : step === 'sync-offline'
                      ? 'offline'
                      : 'twice',
              );
          }
          // the network comes back for good
          for (let i = 0; i < 20 && pending(s).length > 0; i++) sync('ok');
          expect(pending(s)).toEqual([]);
          const rejectedIds = new Set(
            s.queue.filter((q) => q.status === 'rejected').map((q) => q.clientActionId),
          );
          for (const id of made) {
            const r = server.stored.get(id);
            expect(r, 'every action reached the server').toBeDefined();
            expect(rejectedIds.has(id)).toBe(r!.result === 'rejected'); // rejections are visible on the device, applied ones are gone
            expect(server.appliedCount.get(id) ?? 0).toBeLessThanOrEqual(1); // never applied twice
          }
          // photos only remain for rejected actions
          for (const p of s.photos)
            expect(
              [...s.queue].some(
                (q) =>
                  q.status === 'rejected' && (q.action as { photoId?: string }).photoId === p.id,
              ),
            ).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
