import type { CourierAction } from '@courier/shared';
import { getAccessToken } from '@/shared/api';
import { publicEnv } from '@/shared/config';
import type { PhotoRecord, ServerResult } from '../model/engine';
import type { SyncDeps, UploadOutcome } from '../model/runner';

const retriable = (status: number) =>
  status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type ErrBody = { error?: { code?: string; message?: string } };

/** PUT the photo with its device-made id: re-sending the same photo never creates a second file. */
export async function uploadPhoto(p: PhotoRecord): Promise<UploadOutcome> {
  try {
    const res = await fetch(
      `${publicEnv.apiUrl}/courier/photos/${p.id}?deliveryId=${p.deliveryId}&kind=${p.kind}`,
      {
        method: 'PUT',
        headers: { ...(await authHeaders()), 'Content-Type': p.contentType },
        body: new Blob([p.data], { type: p.contentType }),
      },
    );
    if (res.ok) return 'ok';
    if (retriable(res.status)) return 'retry';
    const body = (await res.json().catch(() => ({}))) as ErrBody;
    return {
      reject: {
        code: body.error?.code ?? 'VALIDATION_FAILED',
        message: body.error?.message ?? `HTTP ${res.status}`,
      },
    };
  } catch {
    return 'retry';
  }
}

export async function sendBatch(actions: CourierAction[]): Promise<ServerResult[] | null> {
  try {
    const res = await fetch(`${publicEnv.apiUrl}/courier/actions`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions }),
    });
    if (res.ok) return ((await res.json()) as { results: ServerResult[] }).results;
    if (retriable(res.status)) return null;
    // a 4xx for the whole batch (e.g. validation): do not retry it forever, surface every action as rejected
    const body = (await res.json().catch(() => ({}))) as ErrBody;
    return actions.map((a) => ({
      clientActionId: a.clientActionId,
      result: 'rejected' as const,
      code: body.error?.code ?? 'VALIDATION_FAILED',
      message: body.error?.message ?? `HTTP ${res.status}`,
    }));
  } catch {
    return null;
  }
}

export const networkDeps = (store: Pick<SyncDeps, 'read' | 'mutate'>): SyncDeps => ({
  ...store,
  upload: uploadPhoto,
  send: sendBatch,
});
