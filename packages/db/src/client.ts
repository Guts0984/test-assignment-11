import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type DbOptions = {
  url: string;
  max?: number;
  /** Server-side `statement_timeout`, protects the pool from runaway queries. */
  statementTimeoutMs?: number;
};

export type Sql = ReturnType<typeof postgres>;
export type Db = ReturnType<typeof createDb>['db'];

/**
 * A raw postgres.js pool. NOTE: do not hand this to drizzle(): drizzle rewires the client's JSON and
 * timestamp (de)serializers to pass-through, which breaks `sql.json()` and Date parsing on that client.
 */
export function createSql(opts: DbOptions): Sql {
  return postgres(opts.url, {
    max: opts.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // Postgres numeric types we use are bigint kopecks; they are small enough for JS numbers.
    types: {
      bigint: {
        to: 20,
        from: [20],
        parse: (x: string) => Number(x),
        serialize: (x: number) => String(x),
      },
    },
    connection: opts.statementTimeoutMs
      ? { statement_timeout: opts.statementTimeoutMs }
      : undefined,
  });
}

/** Drizzle pool for application code. Transactions and row locks go through `db.transaction`. */
export function createDb(opts: DbOptions) {
  const sql = createSql(opts);
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
