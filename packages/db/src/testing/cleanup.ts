import type postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

const TEST_USERS = `select id from auth.users where email like 'q-%@example.com' or email like 't-%@example.com'`;
const TEST_DELIVERIES = `select id from public.deliveries where sender_id in (${TEST_USERS})`;
const TEST_SHIFTS = `select id from public.shifts where courier_id in (${TEST_USERS})`;

/** Children first. Each entry: table and the rows of it that belong to test users or test deliveries. */
const DELETES: [string, string][] = [
  [
    'public.notification_attempts',
    `notification_id in (select id from public.notifications where delivery_id in (${TEST_DELIVERIES}))`,
  ],
  ['public.notifications', `delivery_id in (${TEST_DELIVERIES})`],
  [
    'public.courier_actions',
    `delivery_id in (${TEST_DELIVERIES}) or courier_id in (${TEST_USERS})`,
  ],
  ['public.photos', `delivery_id in (${TEST_DELIVERIES})`],
  [
    'public.cash_adjustments',
    `delivery_id in (${TEST_DELIVERIES}) or shift_id in (${TEST_SHIFTS})`,
  ],
  ['public.idempotency_keys', `delivery_id in (${TEST_DELIVERIES})`],
  ['public.assignments', `delivery_id in (${TEST_DELIVERIES}) or courier_id in (${TEST_USERS})`],
  ['public.delivery_events', `delivery_id in (${TEST_DELIVERIES})`],
  ['public.delivery_secrets', `delivery_id in (${TEST_DELIVERIES})`],
  ['public.deliveries', `id in (${TEST_DELIVERIES})`],
  ['public.shifts', `id in (${TEST_SHIFTS})`],
  ['public.sender_webhooks', `sender_id in (${TEST_USERS})`],
  ['public.couriers', `user_id in (${TEST_USERS})`],
  ['public.senders', `user_id in (${TEST_USERS})`],
  ['public.profiles', `user_id in (${TEST_USERS})`],
  ['auth.identities', `user_id in (${TEST_USERS})`],
  ['auth.users', `id in (${TEST_USERS})`],
];

/**
 * Deletes ONLY what the tests created (users q-%/t-%@example.com and everything under them), then resets the delivery
 * number counter. One transaction: any doubt (a seed user in the set, a test courier holding someone else's delivery,
 * non-contiguous numbers afterwards) throws and rolls everything back.
 */
export async function cleanTestData(
  sql: Sql,
): Promise<{ users: number; deliveries: number; counter: number }> {
  return sql.begin(async (tx) => {
    const users = await tx.unsafe(TEST_USERS);
    const deliveries = await tx.unsafe(TEST_DELIVERIES);
    const seed = await tx.unsafe(
      `select 1 from (${TEST_USERS}) u where id::text ~ '^[acd]0000000-0000-4000-8000-'`,
    );
    if (seed.length > 0) throw new Error('cleanTestData: refusing to delete seed users');
    const stray = await tx.unsafe(
      `select 1 from public.deliveries where courier_id in (${TEST_USERS}) and id not in (${TEST_DELIVERIES}) limit 1`,
    );
    if (stray.length > 0)
      throw new Error('cleanTestData: a test courier holds a delivery of a non-test sender');

    // the storage trigger blocks direct deletes unless allowed for this transaction
    await tx`select set_config('storage.allow_delete_query', 'true', true)`;
    await tx.unsafe(
      `delete from storage.objects where bucket_id = 'delivery-photos' and split_part(name, '/', 1) in (select id::text from (${TEST_DELIVERIES}) d)`,
    );
    await tx.unsafe(
      `update public.deliveries set delivered_shift_id = null where delivered_shift_id in (${TEST_SHIFTS})`,
    );
    for (const [table, where] of DELETES) await tx.unsafe(`delete from ${table} where ${where}`);

    const [r] = await tx<{ n: number; mx: number }[]>`
      select count(*)::int n, coalesce(max(number), 0)::int mx from public.deliveries`;
    if (r!.n !== r!.mx)
      throw new Error(
        `cleanTestData: delivery numbers are not contiguous (count ${r!.n}, max ${r!.mx})`,
      );
    await tx`update public.delivery_number_counter set value = ${r!.mx} where id = 1`;
    return { users: users.length, deliveries: deliveries.length, counter: r!.mx };
  });
}
