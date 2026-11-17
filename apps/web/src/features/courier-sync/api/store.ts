import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PhotoRecord, QueuedAction, SyncState } from '../model/engine';

interface CourierDB extends DBSchema {
  queue: { key: string; value: QueuedAction };
  photos: { key: string; value: PhotoRecord };
  meta: { key: string; value: unknown };
}

const NAME = 'courier-app';
const VERSION = 1;
const handles = new Map<string, Promise<IDBPDatabase<CourierDB>>>();

/** One database per name. The courier app uses one per user, so a shared phone never mixes two couriers' queues. */
export function openStore(name = NAME): Promise<IDBPDatabase<CourierDB>> {
  let h = handles.get(name);
  if (!h) {
    h = openDB<CourierDB>(name, VERSION, { upgrade });
    handles.set(name, h);
  }
  return h;
}

export const storeNameFor = (userId: string): string => `courier-app-${userId}`;

function upgrade(db: IDBPDatabase<CourierDB>): void {
  db.createObjectStore('queue', { keyPath: 'clientActionId' });
  db.createObjectStore('photos', { keyPath: 'id' });
  db.createObjectStore('meta');
}

export function resetStoreHandle(): void {
  handles.clear();
}

export type Store = {
  read(): Promise<SyncState>;
  mutate(fn: (s: SyncState) => SyncState): Promise<SyncState>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
};

/** The device store. Every change is one IndexedDB transaction, so a reload or crash never leaves half a change. */
export function createStore(open: () => Promise<IDBPDatabase<CourierDB>> = openStore): Store {
  return {
    async read() {
      const db = await open();
      const tx = db.transaction(['queue', 'photos'], 'readonly');
      const [queue, photos] = await Promise.all([
        tx.objectStore('queue').getAll(),
        tx.objectStore('photos').getAll(),
      ]);
      return { queue: queue.sort((a, b) => a.seq - b.seq), photos };
    },
    async mutate(fn) {
      const db = await open();
      const tx = db.transaction(['queue', 'photos'], 'readwrite');
      const q = tx.objectStore('queue');
      const p = tx.objectStore('photos');
      const before: SyncState = { queue: await q.getAll(), photos: await p.getAll() };
      const after = fn(before);
      const keepQ = new Set(after.queue.map((x) => x.clientActionId));
      const keepP = new Set(after.photos.map((x) => x.id));
      await Promise.all([
        ...before.queue
          .filter((x) => !keepQ.has(x.clientActionId))
          .map((x) => q.delete(x.clientActionId)),
        ...before.photos.filter((x) => !keepP.has(x.id)).map((x) => p.delete(x.id)),
        ...after.queue.map((x) => q.put(x)),
        ...after.photos.map((x) => p.put(x)),
      ]);
      await tx.done;
      return after;
    },
    async getMeta<T>(key: string) {
      const db = await open();
      return (await db.get('meta', key)) as T | undefined;
    },
    async setMeta(key, value) {
      const db = await open();
      await db.put('meta', value, key);
    },
    async deleteMeta(key) {
      const db = await open();
      await db.delete('meta', key);
    },
  };
}
