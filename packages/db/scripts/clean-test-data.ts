import { createSql } from '../src/client';
import { cleanTestData } from '../src/testing/cleanup';
import { testEnv } from '../src/testing/env';

/** Removes the users, deliveries and photos left behind by the test suites (never the seed). */
async function main(): Promise<void> {
  const sql = createSql({ url: testEnv().databaseUrl, max: 2 });
  try {
    const r = await cleanTestData(sql);
    console.log(
      `removed ${r.users} test users and ${r.deliveries} test deliveries; delivery counter is ${r.counter}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
