import type { CourierAction } from '@courier/shared';
import {
  applyResults,
  markUploaded,
  planSync,
  rejectByPhoto,
  type PhotoRecord,
  type RejectInfo,
  type ServerResult,
  type SyncState,
} from './engine';

export type UploadOutcome = 'ok' | 'retry' | { reject: RejectInfo };

export type SyncDeps = {
  read(): Promise<SyncState>;
  /** Atomic read-modify-write on the device store: concurrent enqueues are never overwritten. */
  mutate(fn: (s: SyncState) => SyncState): Promise<SyncState>;
  upload(p: PhotoRecord): Promise<UploadOutcome>;
  /** `null` = could not get an answer (offline, timeout, 5xx): keep everything and try later. */
  send(actions: CourierAction[]): Promise<ServerResult[] | null>;
};

export type SyncReport = {
  sent: number;
  uploaded: number;
  stopped: 'network' | null;
  pending: number;
};

let running: Promise<SyncReport> | null = null;

/**
 * One full sync: photos first, then batches in order, until nothing is left or the network fails.
 * Re-entrant calls share the running sync. The server is idempotent anyway, so a second tab or a retry is harmless.
 */
export function runSync(deps: SyncDeps): Promise<SyncReport> {
  running ??= doSync(deps).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(deps: SyncDeps): Promise<SyncReport> {
  const report: SyncReport = { sent: 0, uploaded: 0, stopped: null, pending: 0 };
  for (let round = 0; round < 50; round++) {
    const state = await deps.read();
    const { uploads, batch } = planSync(state);
    if (uploads.length === 0 && batch.length === 0) break;

    for (const p of uploads) {
      const out = await deps.upload(p);
      if (out === 'retry') {
        report.stopped = 'network';
        return finish(deps, report);
      }
      if (out === 'ok') {
        await deps.mutate((s) => markUploaded(s, p.id));
        report.uploaded++;
      } else {
        // the server will never accept this photo: tell the courier instead of retrying forever
        await deps.mutate((s) => rejectByPhoto(s, p.id, out.reject));
      }
    }

    // re-plan: uploads may have unblocked (or rejected) actions
    const next = planSync(await deps.read());
    if (next.batch.length === 0) continue;
    const answers = await deps.send(next.batch.map((b) => b.action));
    if (!answers) {
      report.stopped = 'network';
      return finish(deps, report);
    }
    await deps.mutate((s) => applyResults(s, answers));
    report.sent += next.batch.length;
  }
  return finish(deps, report);
}

async function finish(deps: SyncDeps, r: SyncReport): Promise<SyncReport> {
  r.pending = (await deps.read()).queue.filter((q) => q.status === 'pending').length;
  return r;
}
