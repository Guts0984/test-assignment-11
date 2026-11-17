import { afterAll } from 'vitest';
import { createSql } from '../src/client';
import { testEnv } from '../src/testing/env';

/** A pool for one test file; closed automatically. `max` is large so concurrency tests really run in parallel. */
export function useDb(max = 60) {
  const sql = createSql({ url: testEnv().databaseUrl, max });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  return { sql };
}

/** Runs `fn` inside a transaction that is always rolled back, so global side effects never reach other tests. */
export async function rolledBack<T>(
  sql: ReturnType<typeof useDb>['sql'],
  fn: (tx: Parameters<Parameters<typeof sql.begin>[1]>[0]) => Promise<T>,
): Promise<T> {
  const marker = Symbol('rollback');
  let out: T | undefined;
  try {
    await sql.begin(async (tx) => {
      out = await fn(tx);
      throw marker;
    });
  } catch (e) {
    if (e !== marker) throw e;
  }
  return out as T;
}
