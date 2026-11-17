import type { CourierAction } from '@courier/shared';

/** Everything the courier app keeps on the device so that nothing is lost without a connection. */
export type RejectInfo = { code: string; message: string; details?: Record<string, unknown> };

export type QueuedAction = {
  clientActionId: string;
  /** Local order: actions are always sent (and applied) in the order the courier did them. */
  seq: number;
  action: CourierAction;
  /** For display only. */
  number: string;
  status: 'pending' | 'rejected';
  reject?: RejectInfo;
  createdAt: string;
};

export type PhotoRecord = {
  id: string;
  deliveryId: string;
  kind: 'handover' | 'failed';
  /** Raw bytes + type (not a Blob): structured-clones reliably into IndexedDB on every browser. */
  data: ArrayBuffer;
  contentType: string;
  uploaded: boolean;
  createdAt: string;
};

export type SyncState = { queue: QueuedAction[]; photos: PhotoRecord[] };

export type ServerResult =
  | {
      clientActionId: string;
      result: 'applied';
      status?: string;
      duplicate?: boolean;
      noop?: boolean;
    }
  | {
      clientActionId: string;
      result: 'rejected';
      code: string;
      message: string;
      details?: Record<string, unknown>;
      duplicate?: boolean;
    };

export const MAX_BATCH = 100;

export const photoIdOf = (a: CourierAction): string | null =>
  a.type === 'pickup' ? null : a.photoId;
export const pending = (s: SyncState): QueuedAction[] =>
  s.queue.filter((q) => q.status === 'pending').sort((a, b) => a.seq - b.seq);

/**
 * What to do next, in order:
 *  1. upload the photos that pending actions refer to (the server refuses a handover whose photo is missing),
 *  2. then send the longest prefix of pending actions whose photos are all uploaded.
 * The prefix rule keeps order: an action never overtakes an earlier one that is still waiting for its photo.
 */
export function planSync(s: SyncState): { uploads: PhotoRecord[]; batch: QueuedAction[] } {
  const byId = new Map(s.photos.map((p) => [p.id, p]));
  const uploads: PhotoRecord[] = [];
  const seen = new Set<string>();
  const batch: QueuedAction[] = [];
  let blocked = false;
  for (const q of pending(s)) {
    const pid = photoIdOf(q.action);
    const photo = pid ? byId.get(pid) : undefined;
    if (pid && photo && !photo.uploaded && !seen.has(pid)) {
      uploads.push(photo);
      seen.add(pid);
    }
    if (pid && (!photo || !photo.uploaded)) blocked = true; // a missing photo record is also a block: it can never be uploaded
    if (!blocked && batch.length < MAX_BATCH) batch.push(q);
  }
  return { uploads, batch };
}

export const markUploaded = (s: SyncState, photoId: string): SyncState => ({
  ...s,
  photos: s.photos.map((p) => (p.id === photoId ? { ...p, uploaded: true } : p)),
});

/**
 * Applies the server's answers. Applied actions leave the queue (and their photo is no longer needed);
 * rejected ones STAY, marked with the reason, until the courier dismisses them: a rejection must never vanish silently.
 * Answers for ids we do not know are ignored, and so are answers for actions that are already rejected.
 */
export function applyResults(s: SyncState, results: ServerResult[]): SyncState {
  const byId = new Map(results.map((r) => [r.clientActionId, r]));
  const done = new Set<string>();
  const queue: QueuedAction[] = [];
  for (const q of s.queue) {
    const r = byId.get(q.clientActionId);
    if (!r || q.status !== 'pending') {
      queue.push(q);
    } else if (r.result === 'applied') {
      done.add(q.clientActionId);
    } else {
      queue.push({
        ...q,
        status: 'rejected',
        reject: { code: r.code, message: r.message, details: r.details },
      });
    }
  }
  const stillNeeded = new Set(
    queue
      .filter((q) => q.status === 'pending')
      .map((q) => photoIdOf(q.action))
      .filter(Boolean) as string[],
  );
  const appliedPhotos = new Set(
    s.queue
      .filter((q) => done.has(q.clientActionId))
      .map((q) => photoIdOf(q.action))
      .filter(Boolean) as string[],
  );
  return {
    queue,
    photos: s.photos.filter((p) => !(appliedPhotos.has(p.id) && !stillNeeded.has(p.id))),
  };
}

/** A photo that can never be uploaded (the server said 4xx): reject every pending action that needs it, with the reason. */
export function rejectByPhoto(s: SyncState, photoId: string, reject: RejectInfo): SyncState {
  return {
    ...s,
    queue: s.queue.map((q) =>
      q.status === 'pending' && photoIdOf(q.action) === photoId
        ? { ...q, status: 'rejected', reject }
        : q,
    ),
  };
}

export function dismissRejected(s: SyncState, clientActionId: string): SyncState {
  const target = s.queue.find(
    (q) => q.clientActionId === clientActionId && q.status === 'rejected',
  );
  if (!target) return s;
  const pid = photoIdOf(target.action);
  const queue = s.queue.filter((q) => q !== target);
  const keep = new Set(queue.map((q) => photoIdOf(q.action)).filter(Boolean));
  return { queue, photos: pid && !keep.has(pid) ? s.photos.filter((p) => p.id !== pid) : s.photos };
}

export function enqueue(
  s: SyncState,
  item: Omit<QueuedAction, 'seq' | 'status' | 'createdAt'>,
  photo?: Omit<PhotoRecord, 'uploaded' | 'createdAt'>,
  now = new Date(),
): SyncState {
  const seq = s.queue.reduce((m, q) => Math.max(m, q.seq), 0) + 1;
  return {
    queue: [...s.queue, { ...item, seq, status: 'pending', createdAt: now.toISOString() }],
    photos: photo
      ? [...s.photos, { ...photo, uploaded: false, createdAt: now.toISOString() }]
      : s.photos,
  };
}

export type LocalDelivery = { id: string; status: string; [k: string]: unknown };

/**
 * The status the courier sees right now: the server's status plus whatever is still waiting on the device.
 * (A pickup waiting to be sent already shows the delivery as picked up.)
 */
export function overlayStatus(
  serverStatus: string,
  deliveryId: string,
  queue: QueuedAction[],
): { status: string; waiting: number } {
  let status = serverStatus;
  let waiting = 0;
  for (const q of [...queue]
    .filter((x) => x.status === 'pending' && x.action.deliveryId === deliveryId)
    .sort((a, b) => a.seq - b.seq)) {
    waiting++;
    if (q.action.type === 'pickup' && status === 'assigned') status = 'picked_up';
    else if (q.action.type === 'deliver') status = 'delivered';
    else if (q.action.type === 'fail') status = 'failed_attempt';
  }
  return { status, waiting };
}
