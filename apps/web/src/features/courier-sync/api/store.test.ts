import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import type { CourierAction } from '@courier/shared';
import { createStore, openStore, resetStoreHandle } from './store';
import { applyResults, enqueue, type ServerResult, type SyncState } from '../model/engine';
import { runSync, type SyncDeps } from '../model/runner';

const uuid = () => crypto.randomUUID();
const deliver = (deliveryId: string): Extract<CourierAction, { type: 'deliver' }> => ({
  type: 'deliver',
  clientActionId: uuid(),
  deliveryId,
  deviceTime: new Date().toISOString(),
  code: '123456',
  codCollectedKop: 500,
  photoId: uuid(),
});
const pickup = (deliveryId: string): CourierAction => ({
  type: 'pickup',
  clientActionId: uuid(),
  deliveryId,
  deviceTime: new Date().toISOString(),
});
const photoFor = (a: Extract<CourierAction, { type: 'deliver' }>) => ({
  id: a.photoId,
  deliveryId: a.deliveryId,
  kind: 'handover' as const,
  data: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]).buffer,
  contentType: 'image/jpeg',
});

beforeEach(() => {
  // a brand-new, empty browser profile for every test
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetStoreHandle();
});

describe('device store (IndexedDB)', () => {
  it('keeps the queue and the photo bytes across a "reload" (the connection is closed and reopened)', async () => {
    const store = createStore();
    const d = deliver(uuid());
    await store.mutate((s) =>
      enqueue(
        enqueue(s, {
          clientActionId: pickup(d.deliveryId).clientActionId,
          action: pickup(d.deliveryId),
          number: 'DLV-1',
        }),
        { clientActionId: d.clientActionId, action: d, number: 'DLV-1' },
        photoFor(d),
      ),
    );
    (await openStore()).close();
    resetStoreHandle(); // the page is gone; a new one opens the same database
    const after = await createStore().read();
    expect(after.queue.map((q) => q.action.type)).toEqual(['pickup', 'deliver']);
    expect(after.queue.map((q) => q.seq)).toEqual([1, 2]);
    expect(after.photos).toHaveLength(1);
    expect(new Uint8Array(after.photos[0]!.data)).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]),
    );
    expect(after.photos[0]!.contentType).toBe('image/jpeg');
  });

  it('seq numbers keep growing after a restart (order is never reused)', async () => {
    let store = createStore();
    const a = pickup(uuid());
    await store.mutate((s) =>
      enqueue(s, { clientActionId: a.clientActionId, action: a, number: 'x' }),
    );
    (await openStore()).close();
    resetStoreHandle();
    store = createStore();
    const b = pickup(uuid());
    const s2 = await store.mutate((s) =>
      enqueue(s, { clientActionId: b.clientActionId, action: b, number: 'x' }),
    );
    expect(s2.queue.map((q) => q.seq)).toEqual([1, 2]);
  });

  it('a mutation that throws changes nothing (atomic)', async () => {
    const store = createStore();
    const a = pickup(uuid());
    await store.mutate((s) =>
      enqueue(s, { clientActionId: a.clientActionId, action: a, number: 'x' }),
    );
    await expect(
      store.mutate(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await store.read()).queue).toHaveLength(1);
  });

  it('concurrent writers never lose each other’s actions (20 parallel enqueues)', async () => {
    const store = createStore();
    const ids = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const a = pickup(uuid());
        await store.mutate((s) =>
          enqueue(s, { clientActionId: a.clientActionId, action: a, number: 'x' }),
        );
        return a.clientActionId;
      }),
    );
    const s = await store.read();
    expect(new Set(s.queue.map((q) => q.clientActionId))).toEqual(new Set(ids));
    expect(new Set(s.queue.map((q) => q.seq)).size).toBe(20);
  });

  it('meta values persist', async () => {
    const store = createStore();
    await store.setMeta('lastSync', '2026-01-01T00:00:00Z');
    expect(await createStore().getMeta('lastSync')).toBe('2026-01-01T00:00:00Z');
    expect(await store.getMeta('missing')).toBeUndefined();
  });

  it('a database with the wrong shape is not touched by another name', async () => {
    const other = await openStore('some-other-db');
    expect([...other.objectStoreNames].sort()).toEqual(['meta', 'photos', 'queue']);
    other.close();
    void openDB;
  });
});

/** A server double with the real contract: idempotent per clientActionId, photos stored once. */
function serverDouble(opts: { rejectCode?: string } = {}) {
  const results = new Map<string, ServerResult>();
  const photos = new Map<string, number>();
  const calls = { batches: 0, uploads: 0 };
  let online = true;
  const deps = (store: ReturnType<typeof createStore>): SyncDeps => ({
    read: () => store.read(),
    mutate: (fn) => store.mutate(fn),
    async upload(p) {
      if (!online) return 'retry';
      calls.uploads++;
      photos.set(p.id, (photos.get(p.id) ?? 0) + 1);
      return 'ok';
    },
    async send(actions) {
      if (!online) return null;
      calls.batches++;
      return actions.map((a): ServerResult => {
        const prev = results.get(a.clientActionId);
        if (prev) return { ...prev, duplicate: true };
        const r: ServerResult =
          opts.rejectCode && a.type === 'deliver'
            ? {
                clientActionId: a.clientActionId,
                result: 'rejected',
                code: opts.rejectCode,
                message: 'nope',
              }
            : { clientActionId: a.clientActionId, result: 'applied' };
        results.set(a.clientActionId, r);
        return r;
      });
    },
  });
  return { deps, results, photos, calls, setOnline: (v: boolean) => (online = v) };
}

describe('offline scenario end to end (acceptance 19), against the real device store', () => {
  it('two actions queued offline survive a reload and are both applied once the network is back', async () => {
    const srv = serverDouble();
    let store = createStore();
    const id = uuid();
    const p = pickup(id);
    const d = deliver(id);
    srv.setOnline(false);
    await store.mutate((s) =>
      enqueue(s, { clientActionId: p.clientActionId, action: p, number: 'DLV-1' }),
    );
    await store.mutate((s) =>
      enqueue(s, { clientActionId: d.clientActionId, action: d, number: 'DLV-1' }, photoFor(d)),
    );
    const offline = await runSync(srv.deps(store));
    expect(offline).toMatchObject({ stopped: 'network', pending: 2 });

    (await openStore()).close(); // reload / phone restart
    resetStoreHandle();
    store = createStore();
    expect((await store.read()).queue).toHaveLength(2);

    srv.setOnline(true);
    const online = await runSync(srv.deps(store));
    expect(online).toMatchObject({ stopped: null, pending: 0, sent: 2, uploaded: 1 });
    expect([...srv.results.values()].map((r) => r.result)).toEqual(['applied', 'applied']);
    expect(await store.read()).toEqual({ queue: [], photos: [] });
  });

  it('the same queue sent twice (second tab, retry after a lost response) is applied once and the photo uploaded once', async () => {
    const srv = serverDouble();
    const store = createStore();
    const d = deliver(uuid());
    await store.mutate((s) =>
      enqueue(s, { clientActionId: d.clientActionId, action: d, number: 'x' }, photoFor(d)),
    );
    // the response is lost: the server applied it, the device does not know
    const lostDeps = srv.deps(store);
    await runSync({
      ...lostDeps,
      send: async (a) => {
        await lostDeps.send(a);
        return null;
      },
    });
    expect((await store.read()).queue).toHaveLength(1);
    await runSync(srv.deps(store));
    expect((await store.read()).queue).toHaveLength(0);
    expect(srv.results.size).toBe(1);
    expect([...srv.results.values()].filter((r) => !('duplicate' in r)).length).toBe(1);
    expect(srv.photos.get(d.photoId)).toBe(1);
  });

  it('a rejected action stays on the device with its reason (and its photo) until dismissed', async () => {
    const srv = serverDouble({ rejectCode: 'WRONG_CODE' });
    const store = createStore();
    const d = deliver(uuid());
    await store.mutate((s) =>
      enqueue(s, { clientActionId: d.clientActionId, action: d, number: 'DLV-7' }, photoFor(d)),
    );
    await runSync(srv.deps(store));
    const s = await store.read();
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]).toMatchObject({
      status: 'rejected',
      number: 'DLV-7',
      reject: { code: 'WRONG_CODE', message: 'nope' },
    });
    expect(s.photos).toHaveLength(1);
    // and a later sync does not send it again
    const before = srv.calls.batches;
    await runSync(srv.deps(store));
    expect(srv.calls.batches).toBe(before);
  });

  it('actions added while a sync is running are not lost', async () => {
    const srv = serverDouble();
    const store = createStore();
    const a = pickup(uuid());
    await store.mutate((s) =>
      enqueue(s, { clientActionId: a.clientActionId, action: a, number: 'x' }),
    );
    const late = pickup(uuid());
    const base = srv.deps(store);
    const sync = runSync({
      ...base,
      send: async (acts) => {
        // the courier taps another button while the request is in flight
        await store.mutate((s) =>
          enqueue(s, { clientActionId: late.clientActionId, action: late, number: 'x' }),
        );
        return base.send(acts);
      },
    });
    await sync;
    // the late action was neither overwritten nor skipped: the same sync run noticed it and sent it too
    expect(srv.results.has(a.clientActionId)).toBe(true);
    expect(srv.results.has(late.clientActionId)).toBe(true);
    expect((await store.read()).queue).toHaveLength(0);
    expect(srv.results.size).toBe(2);
  });

  it('a photo the server refuses for good turns its action into a visible rejection instead of blocking the queue', async () => {
    const srv = serverDouble();
    const store = createStore();
    const d = deliver(uuid());
    const later = pickup(uuid());
    await store.mutate((s) =>
      enqueue(s, { clientActionId: d.clientActionId, action: d, number: 'x' }, photoFor(d)),
    );
    await store.mutate((s) =>
      enqueue(s, { clientActionId: later.clientActionId, action: later, number: 'y' }),
    );
    await runSync({
      ...srv.deps(store),
      upload: async () => ({ reject: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'bad image' } }),
    });
    const s = await store.read();
    expect(s.queue.find((q) => q.clientActionId === d.clientActionId)).toMatchObject({
      status: 'rejected',
      reject: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
    expect(srv.results.has(later.clientActionId)).toBe(true); // the rest of the queue still went through
  });

  it('a hundred-plus actions go out in order, in batches', async () => {
    const srv = serverDouble();
    const store = createStore();
    const ids: string[] = [];
    for (let i = 0; i < 230; i++) {
      const a = pickup(uuid());
      ids.push(a.clientActionId);
      await store.mutate((s) =>
        enqueue(s, { clientActionId: a.clientActionId, action: a, number: 'x' }),
      );
    }
    const r = await runSync(srv.deps(store));
    expect(r).toMatchObject({ sent: 230, pending: 0 });
    expect(srv.calls.batches).toBe(3);
    expect([...srv.results.keys()]).toEqual(ids);
  });

  it('applyResults is the only thing that removes an action (a lost response removes nothing)', async () => {
    const store = createStore();
    const a = pickup(uuid());
    await store.mutate((s) =>
      enqueue(s, { clientActionId: a.clientActionId, action: a, number: 'x' }),
    );
    const s: SyncState = await store.read();
    expect(applyResults(s, []).queue).toHaveLength(1);
  });
});
