'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CourierAction } from '@courier/shared';
import { createStore } from '../api/store';
import { networkDeps } from '../api/network';
import { dismissRejected, enqueue, type PhotoRecord, type SyncState } from '../model/engine';
import { runSync } from '../model/runner';

const EMPTY: SyncState = { queue: [], photos: [] };

/** Device queue + background sync. State comes from IndexedDB, so it survives reloads and restarts. */
export function useCourierSync(onSynced?: () => void) {
  const store = useRef(createStore()).current;
  const [state, setState] = useState<SyncState>(EMPTY);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const cb = useRef(onSynced);
  cb.current = onSynced;

  const reload = useCallback(async () => setState(await store.read()), [store]);

  const syncNow = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    setSyncing(true);
    try {
      const r = await runSync(networkDeps(store));
      await reload();
      if (r.sent > 0 || r.uploaded > 0) {
        const now = new Date().toISOString();
        setLastSync(now);
        void store.setMeta('lastSync', now);
        cb.current?.();
      }
    } finally {
      setSyncing(false);
    }
  }, [store, reload]);

  useEffect(() => {
    setOnline(navigator.onLine);
    void navigator.storage?.persist?.(); // ask the browser not to evict the queue
    void (async () => {
      await reload();
      setLastSync((await store.getMeta<string>('lastSync')) ?? null);
      setReady(true);
      void syncNow(); // the app just opened: send whatever was left from last time
    })();
    const on = () => {
      setOnline(true);
      void syncNow();
    };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [reload, syncNow, store]);

  // while something waits and we are online, keep trying (covers a flaky connection that never fires "online")
  const waiting = state.queue.filter((q) => q.status === 'pending').length;
  useEffect(() => {
    if (!waiting || !online) return;
    const t = setInterval(() => void syncNow(), 8000);
    return () => clearInterval(t);
  }, [waiting, online, syncNow]);

  const add = useCallback(
    async (
      action: CourierAction,
      number: string,
      photo?: Omit<PhotoRecord, 'uploaded' | 'createdAt'>,
    ) => {
      // One atomic write: the action and its photo reach the device store together or not at all.
      setState(
        await store.mutate((s) =>
          enqueue(s, { clientActionId: action.clientActionId, action, number }, photo),
        ),
      );
      void syncNow();
    },
    [store, syncNow],
  );

  const dismiss = useCallback(
    async (id: string) => setState(await store.mutate((s) => dismissRejected(s, id))),
    [store],
  );

  return { state, ready, online, syncing, lastSync, waiting, add, dismiss, syncNow, store };
}
