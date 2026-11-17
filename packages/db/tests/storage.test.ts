import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useDb } from './db';
import { buildWorld, type World } from './world';
import { adminClient, anonClient } from '../src/testing/users';
import { testEnv } from '../src/testing/env';
import { sleep } from '../src/testing/fixtures';

const { sql } = useDb(5);
const env = testEnv();
const BUCKET = 'delivery-photos';
let w: World;
let pathA: string;
let pathB: string;
const bytesA = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD', 'base64'); // starts like a JPEG
const bytesB = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB', 'base64');

beforeAll(async () => {
  w = await buildWorld(sql);
  pathA = `${w.deliveries.dA1.id}/${w.photos.A}.jpg`;
  pathB = `${w.deliveries.dB1.id}/${w.photos.B}.jpg`;
  const admin = adminClient();
  for (const [p, b] of [
    [pathA, bytesA],
    [pathB, bytesB],
  ] as const) {
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(p, b, { contentType: 'image/jpeg', upsert: true });
    expect(error).toBeNull();
  }
}, 120_000);

afterAll(async () => {
  await adminClient().storage.from(BUCKET).remove([pathA, pathB]);
});

const roles = () => ({
  senderA: w.sessions.senderA.client,
  senderB: w.sessions.senderB.client,
  courierA: w.sessions.courierA.client,
  courierB: w.sessions.courierB.client,
  dispatcher: w.sessions.dispatcher.client,
  sneaky: w.sessions.sneaky.client,
  anon: anonClient(),
});

describe('private bucket: browsers cannot read, list or sign anything (invariant 12)', () => {
  it('the bucket is private with a size limit and image-only mime types', async () => {
    const [b] =
      await sql`select public, file_size_limit, allowed_mime_types from storage.buckets where id = ${BUCKET}`;
    expect(b!.public).toBe(false);
    expect(Number(b!.file_size_limit)).toBe(5_242_880);
    expect([...b!.allowed_mime_types].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('no policy exists on the bucket: access is only through the API, which signs short-lived URLs', async () => {
    const rows =
      await sql`select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'`;
    expect(rows).toEqual([]);
  });

  const roleNames = [
    'senderA',
    'senderB',
    'courierA',
    'courierB',
    'dispatcher',
    'sneaky',
    'anon',
  ] as const;
  it.each(roleNames.flatMap((r) => (['A', 'B'] as const).map((w) => [r, w] as const)))(
    '%s cannot sign, download or list photo of %s',
    async (role, which) => {
      const path = which === 'A' ? pathA : pathB;
      const c = roles()[role].storage.from(BUCKET);
      const signed = await c.createSignedUrl(path, 60);
      expect(signed.data?.signedUrl ?? null).toBeNull();
      expect(signed.error).not.toBeNull();
      expect((await c.download(path)).error).not.toBeNull();
      expect((await c.list(path.split('/')[0]!)).data ?? []).toHaveLength(0);
    },
  );

  it('a user cannot mint a long-lived link for their own photo (the 10-year signed URL bypass)', async () => {
    const r = await w.sessions.senderA.client.storage
      .from(BUCKET)
      .createSignedUrl(pathA, 10 * 365 * 86_400);
    expect(r.data?.signedUrl ?? null).toBeNull();
    expect(r.error).not.toBeNull();
  });

  it('the authenticated object endpoint refuses a sender who owns the delivery', async () => {
    const res = await fetch(
      `${env.supabaseUrl}/storage/v1/object/authenticated/${BUCKET}/${pathA}`,
      {
        headers: { apikey: env.anonKey, Authorization: `Bearer ${w.sessions.senderA.accessToken}` },
      },
    );
    expect(res.status).not.toBe(200);
  });

  it('the service role (the API) can sign, and the signed URL serves exactly the stored bytes', async () => {
    const { data, error } = await adminClient().storage.from(BUCKET).createSignedUrl(pathA, 60);
    expect(error).toBeNull();
    const res = await fetch(data!.signedUrl);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytesA)).toBe(true);
    expect((await fetch(data!.signedUrl.replace(pathA, pathB))).status).not.toBe(200);
  });
});

describe('public and unauthenticated access is impossible', () => {
  it('the public object URL does not serve the photo', async () => {
    const res = await fetch(`${env.supabaseUrl}/storage/v1/object/public/${BUCKET}/${pathA}`);
    expect(res.status).not.toBe(200);
  });
  it('the authenticated object URL refuses the anon key and refuses no key', async () => {
    const a = await fetch(`${env.supabaseUrl}/storage/v1/object/${BUCKET}/${pathA}`, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` },
    });
    expect(a.status).not.toBe(200);
    const b = await fetch(`${env.supabaseUrl}/storage/v1/object/${BUCKET}/${pathA}`);
    expect(b.status).not.toBe(200);
  });
  it('another sender’s JWT cannot read the object through the raw endpoint either', async () => {
    const res = await fetch(`${env.supabaseUrl}/storage/v1/object/${BUCKET}/${pathA}`, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${w.sessions.senderB.accessToken}` },
    });
    expect(res.status).not.toBe(200);
  });
});

describe('browsers cannot write to the bucket', () => {
  it.each(['senderA', 'courierA', 'dispatcher', 'anon'] as const)(
    '%s cannot upload, overwrite, move or delete',
    async (role) => {
      const c = roles()[role].storage.from(BUCKET);
      const fresh = `${w.deliveries.dA1.id}/${randomUUID()}.jpg`;
      expect((await c.upload(fresh, bytesA, { contentType: 'image/jpeg' })).error).not.toBeNull();
      expect(
        (await c.upload(pathA, bytesB, { contentType: 'image/jpeg', upsert: true })).error,
      ).not.toBeNull();
      expect((await c.move(pathA, `${w.deliveries.dA1.id}/moved.jpg`)).error).not.toBeNull();
      await c.remove([pathA]);
      const { data } = await adminClient().storage.from(BUCKET).download(pathA);
      expect(Buffer.from(await data!.arrayBuffer()).equals(bytesA)).toBe(true); // still there, still the original
      const listing = await adminClient().storage.from(BUCKET).list(w.deliveries.dA1.id);
      expect(listing.data?.map((o) => o.name)).toEqual([`${w.photos.A}.jpg`]);
    },
  );

  it('even the service role cannot store a non-image or an oversized file (bucket limits)', async () => {
    const admin = adminClient().storage.from(BUCKET);
    const text = await admin.upload(
      `${w.deliveries.dA1.id}/${randomUUID()}.txt`,
      Buffer.from('hello'),
      { contentType: 'text/plain' },
    );
    expect(text.error).not.toBeNull();
    const html = await admin.upload(
      `${w.deliveries.dA1.id}/${randomUUID()}.html`,
      Buffer.from('<script>1</script>'),
      { contentType: 'text/html' },
    );
    expect(html.error).not.toBeNull();
    const big = await admin.upload(
      `${w.deliveries.dA1.id}/${randomUUID()}.jpg`,
      Buffer.alloc(5_242_881),
      { contentType: 'image/jpeg' },
    );
    expect(big.error).not.toBeNull();
  });
});

describe('signed URLs expire and cannot be reused for other objects', () => {
  it('a signed URL stops working after its lifetime', async () => {
    const { data } = await adminClient().storage.from(BUCKET).createSignedUrl(pathA, 2);
    expect((await fetch(data!.signedUrl)).status).toBe(200);
    await sleep(3500);
    expect((await fetch(data!.signedUrl)).status).not.toBe(200);
  });

  it('a tampered token is refused', async () => {
    const { data } = await adminClient().storage.from(BUCKET).createSignedUrl(pathA, 60);
    const url = new URL(data!.signedUrl);
    const token = url.searchParams.get('token')!;
    const [h, p, s] = token.split('.');
    url.searchParams.set('token', `${h}.${p}.${s!.slice(0, -2)}xx`);
    expect((await fetch(url)).status).not.toBe(200);
  });

  it('a token for photo A does not unlock photo B', async () => {
    const { data } = await adminClient().storage.from(BUCKET).createSignedUrl(pathA, 60);
    const url = new URL(data!.signedUrl);
    url.pathname = url.pathname.replace(encodeURI(pathA), encodeURI(pathB)).replace(pathA, pathB);
    expect(url.pathname).toContain(w.deliveries.dB1.id);
    expect((await fetch(url)).status).not.toBe(200);
  });
});
