import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { useDb } from './db';
import { cleanTestData } from '../src/testing/cleanup';
import { assignDelivery, createDelivery, createProfiled, openShift } from '../src/testing/fixtures';
import { adminClient } from '../src/testing/users';

const { sql } = useDb(5);
const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;

describe('cleanTestData', () => {
  it('removes test users and everything under them, keeps the seed, keeps numbering gapless', async () => {
    const sender = await createProfiled(sql, 'sender');
    const courier = await createProfiled(sql, 'courier');
    const dispatcher = await createProfiled(sql, 'dispatcher');
    await openShift(sql, courier.id);
    const d = await createDelivery(sql, { senderId: sender.id });
    await assignDelivery(sql, d.id, courier.id, dispatcher.id);
    const photoId = randomUUID();
    const path = `${d.id}/${photoId}.jpg`;
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    expect(
      (
        await adminClient()
          .storage.from('delivery-photos')
          .upload(path, bytes, { contentType: 'image/jpeg' })
      ).error,
    ).toBeNull();
    await sql`insert into public.photos (id, delivery_id, courier_id, kind, storage_path, sha256, size_bytes, content_type)
      values (${photoId}, ${d.id}, ${courier.id}, 'handover', ${path}, ${createHash('sha256').update(bytes).digest('hex')}, ${bytes.length}, 'image/jpeg')`;

    const r = await cleanTestData(sql);
    expect(r.users).toBeGreaterThanOrEqual(3);

    const ids = [sender.id, courier.id, dispatcher.id];
    expect(await count(sql`select count(*)::int n from auth.users where id = any(${ids})`)).toBe(0);
    expect(await count(sql`select count(*)::int n from public.deliveries where id = ${d.id}`)).toBe(
      0,
    );
    expect(
      await count(
        sql`select count(*)::int n from public.notifications where delivery_id = ${d.id}`,
      ),
    ).toBe(0);
    expect(await count(sql`select count(*)::int n from storage.objects where name = ${path}`)).toBe(
      0,
    );
    // the seed is untouched and the counter matches the survivors
    expect(
      await count(
        sql`select count(*)::int n from auth.users where id::text ~ '^(a|d|c)0000000-0000-4000-8000-'`,
      ),
    ).toBe(35);
    expect(
      await count(
        sql`select count(*)::int n from public.deliveries where sender_id::text like 'a0000000-%'`,
      ),
    ).toBe(50000);
    const [c] = await sql<{ value: number; mx: number }[]>`
      select (select value from public.delivery_number_counter)::int value, max(number)::int mx from public.deliveries`;
    expect(c!.value).toBe(c!.mx);
  });

  it('is idempotent, and the next delivery continues the numbering without a gap', async () => {
    await cleanTestData(sql);
    const sender = await createProfiled(sql, 'sender');
    const [m] = await sql<{ mx: number }[]>`select max(number)::int mx from public.deliveries`;
    expect((await createDelivery(sql, { senderId: sender.id })).number).toBe(m!.mx + 1);
  });
});
