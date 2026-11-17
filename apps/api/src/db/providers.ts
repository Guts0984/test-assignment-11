import { createDb, type Db } from '@courier/db';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../config/env';

export type DbHandle = { db: Db; close: () => Promise<void> };

export function createDbHandle(env: Env): DbHandle {
  const { db, close } = createDb({
    url: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
  });
  return { db, close };
}

/** Server-side only: the service-role key never leaves the API process. */
export function createStorageClient(env: Env): SupabaseClient {
  return createClient(env.internalSupabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
