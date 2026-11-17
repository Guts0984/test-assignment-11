import { createSql } from '../src/client';
import { cleanTestData } from '../src/testing/cleanup';
import { testEnv } from '../src/testing/env';

/** Removes every user, delivery and photo the suite created. Set KEEP_TEST_DATA=1 to inspect them afterwards. */
export async function teardown(): Promise<void> {
  if (process.env.KEEP_TEST_DATA === '1') return;
  const sql = createSql({ url: testEnv().databaseUrl, max: 2 });
  try {
    await cleanTestData(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
