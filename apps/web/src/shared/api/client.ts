import type { ApiErrorBody, ErrorCode } from '@courier/shared';
import { publicEnv } from '../config/env';
import { getAccessToken } from './supabase';

export type ApiError = Error & {
  name: 'ApiError';
  status: number;
  code: ErrorCode | 'NETWORK';
  details?: Record<string, unknown>;
  /** field path → message, ready for react-hook-form */
  fields: Record<string, string>;
  requestId?: string;
};

export function makeApiError(init: {
  status: number;
  code: ApiError['code'];
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}): ApiError {
  const e = new Error(init.message) as ApiError;
  e.name = 'ApiError';
  e.status = init.status;
  e.code = init.code;
  e.details = init.details;
  e.requestId = init.requestId;
  const raw = init.details?.fields;
  e.fields = raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
  return e;
}

export const isApiError = (e: unknown): e is ApiError =>
  e instanceof Error && e.name === 'ApiError';

export type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  headers?: Record<string, string>;
  /** Public endpoints (tracking) send no token. */
  anonymous?: boolean;
  signal?: AbortSignal;
};

/** Calls the API with the user's Supabase JWT. Every failure becomes an ApiError with a stable `code`. */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!opts.anonymous) {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${publicEnv.apiUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch {
    throw makeApiError({ status: 0, code: 'NETWORK', message: 'Network error' });
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw makeApiError({
      status: res.status,
      code: err?.code ?? 'INTERNAL',
      message: err?.message ?? res.statusText,
      details: err?.details,
      requestId: err?.requestId,
    });
  }
  return json as T;
}

/** A page of a paginated API list. */
export type ListPage<T> = { items: T[]; total: number; page: number; pageSize: number };
