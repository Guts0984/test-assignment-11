import { createDelivery, assignDelivery } from '@courier/db/testing';
import {
  test,
  expect,
  login,
  createDeliveryViaForm,
  assignViaCard,
  stubMode,
  stubReceived,
  JPEG,
} from './fixtures';

const money = (n: number) => `₴${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

test.describe('acceptance 3: create → assign → picked up → handed over by code', () => {
  test('four browsers, one delivery: tracking and the board update by themselves', async ({
    world,
    open,
  }) => {
    // the recipient and the dispatcher's board are already open BEFORE anything happens
    const sender = await open();
    await login(sender, world.sender, /\/sender$/);
    const created = await createDeliveryViaForm(sender, { cod: '1000', weight: '2,5' });
    expect(created.number).toMatch(/^DLV-\d{6}$/);

    const recipient = await open();
    await recipient.goto(created.trackingPath);
    await expect(recipient.getByTestId('tr-number')).toHaveText(created.number);
    await expect(recipient.getByTestId('tr-status')).toHaveText('Created');
    await expect(recipient.getByTestId('tr-amount')).toHaveText(money(1000));
    const code = (await recipient.getByTestId('tr-code').textContent())!.trim();
    expect(code).toMatch(/^\d{6}$/);
    await expect(recipient.getByTestId('tr-courier')).toHaveText('Not assigned yet');

    const board = await open();
    await login(board, world.dispatcher, /\/dispatcher$/);
    const courierRow = board.getByTestId('courier-row').filter({ hasText: world.courierName });
    await expect(courierRow.getByTestId('load')).toHaveText('0/8');

    // dispatcher assigns (a second tab of the same session)
    const dispatcherTab = await board.context().newPage();
    await assignViaCard(dispatcherTab, created.id, world.courierName);
    await expect(courierRow.getByTestId('load')).toHaveText('1/8'); // the board changed without a reload
    await expect(recipient.getByTestId('tr-status')).toHaveText('Assigned'); // so did the tracking page
    await expect(recipient.getByTestId('tr-courier')).toHaveText(/^Kurier A\.$/);

    // the courier, on a 360 px phone
    const phone = await open({ mobile: true });
    await login(phone, world.courier, /\/courier$/);
    const card = phone.getByTestId('delivery').filter({ hasText: created.number });
    await expect(card).toBeVisible();
    expect(
      await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await card.getByRole('button', { name: 'Picked up' }).click();
    await expect(card.locator('[data-status]').first()).toHaveText('Picked up');
    await expect(phone.getByTestId('waiting')).toHaveText('Everything is sent');
    await expect(recipient.getByTestId('tr-status')).toHaveText('Picked up');

    await card.getByRole('button', { name: 'Handed over' }).click();
    const dialog = phone.getByRole('dialog');
    // a wrong code is refused by the server and shown to the courier, with its reason
    await dialog.getByLabel("Recipient's code").fill(code === '000000' ? '111111' : '000000');
    await dialog
      .getByLabel('Photo of the handover')
      .setInputFiles({ name: 'p.jpg', mimeType: 'image/jpeg', buffer: JPEG });
    await dialog.getByRole('button', { name: 'Confirm handover' }).click();
    await expect(phone.getByTestId('rejected-item')).toContainText('Wrong code');
    await phone.getByTestId('rejected-item').getByRole('button', { name: 'Dismiss' }).click();
    await expect(phone.getByTestId('rejected')).toBeHidden();

    await card.getByRole('button', { name: 'Handed over' }).click();
    await dialog.getByLabel("Recipient's code").fill(code);
    await dialog.getByLabel('Amount received, ₴').fill('1000');
    await dialog
      .getByLabel('Photo of the handover')
      .setInputFiles({ name: 'p.jpg', mimeType: 'image/jpeg', buffer: JPEG });
    await dialog.getByRole('button', { name: 'Confirm handover' }).click();

    await expect(recipient.getByTestId('tr-status')).toHaveText('Delivered', { timeout: 30_000 });
    await expect(courierRow.getByTestId('load')).toHaveText('0/8');
    await expect(card).toHaveCount(0, { timeout: 20_000 }); // delivered work leaves the courier's list

    // the sender sees the proof of delivery and the whole history
    await sender.goto(`/sender/${created.id}`);
    // created, assigned, picked up, the wrong code the courier tried first, delivered
    await expect(sender.getByTestId('history').locator('li')).toHaveCount(5);
    // two handover photos: the wrong-code attempt uploaded one too (it is the courier's evidence, kept on purpose)
    const img = sender.getByRole('img', { name: 'Handover photo' }).first();
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0); // the signed URL really serves the image

    // and the notifications reached the sender's server, signed and in order
    await expect
      .poll(
        async () =>
          (await stubReceived()).received.filter(
            (r) => r.body.deliveryId === created.id && r.answered === 200,
          ).length,
        { timeout: 30_000 },
      )
      .toBe(4);
    const got = (await stubReceived()).received.filter((r) => r.body.deliveryId === created.id);
    expect(got.map((r) => r.body.event)).toEqual(['created', 'assigned', 'picked_up', 'delivered']);
    expect(got.every((r) => r.signatureValid)).toBe(true);
  });
});

test.describe('acceptance 19 / required e2e 2: the courier works offline', () => {
  test('two actions made offline survive a reload and are both applied when the network returns', async ({
    world,
    open,
  }) => {
    const { sql } = world;
    const d = await createDelivery(sql, { senderId: world.sender.id, codKop: 25_000 });
    await assignDelivery(sql, d.id, world.courier.id, world.dispatcher.id);

    const phone = await open({ mobile: true });
    await login(phone, world.courier, /\/courier$/);
    const card = phone.getByTestId('delivery').filter({ hasText: d.publicNumber });
    await expect(card).toBeVisible();
    // let the service worker take control and cache the app, then cut the network
    await phone.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await phone.reload();
    await expect(card).toBeVisible();
    await phone.evaluate(() => navigator.serviceWorker.ready);
    await phone.context().setOffline(true);
    await expect(phone.getByTestId('net')).toContainText('Offline');

    await card.getByRole('button', { name: 'Picked up' }).click();
    await expect(phone.getByTestId('waiting')).toHaveText('1 action waiting to be sent');
    await card.getByRole('button', { name: 'Handed over' }).click();
    const dialog = phone.getByRole('dialog');
    await dialog.getByLabel("Recipient's code").fill(d.code);
    await dialog.getByLabel('Amount received, ₴').fill('250');
    await dialog
      .getByLabel('Photo of the handover')
      .setInputFiles({ name: 'p.jpg', mimeType: 'image/jpeg', buffer: JPEG });
    await dialog.getByRole('button', { name: 'Confirm handover' }).click();
    await expect(phone.getByTestId('waiting')).toHaveText('2 actions waiting to be sent');
    await expect(card.locator('[data-status]').first()).toHaveText('Delivered'); // what the courier did is visible right away
    await expect(card.getByTestId('d-waiting')).toBeVisible();

    // reload while still offline: the page opens from the cache and the queue is exactly where it was
    await phone.reload();
    await expect(phone.getByTestId('waiting')).toHaveText('2 actions waiting to be sent');
    await expect(phone.getByTestId('delivery').filter({ hasText: d.publicNumber })).toBeVisible();
    const [dbWhileOffline] = await sql`select status from public.deliveries where id = ${d.id}`;
    expect(dbWhileOffline!.status).toBe('assigned'); // nothing reached the server

    await phone.context().setOffline(false);
    await expect(phone.getByTestId('waiting')).toHaveText('Everything is sent', {
      timeout: 40_000,
    });
    const [row] =
      await sql`select status, cod_collected_kop, courier_id from public.deliveries where id = ${d.id}`;
    expect(row).toMatchObject({
      status: 'delivered',
      cod_collected_kop: 25_000,
      courier_id: world.courier.id,
    });
    const ev =
      await sql`select type, device_time from public.delivery_events where delivery_id = ${d.id} and type in ('picked_up','delivered') order by id`;
    expect(ev.map((e) => e.type)).toEqual(['picked_up', 'delivered']);
    expect(ev.every((e) => e.device_time !== null)).toBe(true);
    expect(await sql`select 1 from public.photos where delivery_id = ${d.id}`).toHaveLength(1);
    expect(
      await sql`select 1 from public.courier_actions where delivery_id = ${d.id} and result = 'applied'`,
    ).toHaveLength(2);
  });
});

test.describe('acceptance 12 / required e2e 3: the sender’s server is down, then comes back', () => {
  test.afterEach(async () => {
    await stubMode('ok');
  });

  test('notifications are retried and arrive in order, each exactly once as delivered', async ({
    world,
    open,
  }) => {
    await stubMode('error');
    const sender = await open();
    await login(sender, world.sender, /\/sender$/);
    const created = await createDeliveryViaForm(sender);
    const { sql } = world;
    const [row] = await sql<
      { id: string }[]
    >`select id from public.deliveries where id = ${created.id}`;
    const dispatcher = await open();
    await login(dispatcher, world.dispatcher, /\/dispatcher$/);
    await assignViaCard(dispatcher, row!.id, world.courierName);
    const phone = await open({ mobile: true });
    await login(phone, world.courier, /\/courier$/);
    const card = phone.getByTestId('delivery').filter({ hasText: created.number });
    await card.getByRole('button', { name: 'Picked up' }).click();
    await expect(card).toContainText('Picked up'); // the tap is queued and shown
    await expect
      .poll(
        async () =>
          (await sql`select status from public.deliveries where id = ${created.id}`)[0]!.status,
        { timeout: 20_000 },
      )
      .toBe('picked_up'); // and has reached the server

    // while the sender's server fails, only the FIRST notification is being retried: later ones wait behind it
    await expect
      .poll(
        async () =>
          (await stubReceived()).received.filter((r) => r.body.deliveryId === created.id).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(2);
    const during = (await stubReceived()).received.filter((r) => r.body.deliveryId === created.id);
    expect(new Set(during.map((r) => r.body.event))).toEqual(new Set(['created']));
    expect(during.every((r) => r.answered === 500)).toBe(true);
    const pending =
      await sql`select seq, status, attempts from public.notifications where delivery_id = ${created.id} order by seq`;
    expect(pending.map((p) => [p.seq, p.status, p.attempts])).toEqual([
      [1, 'pending', expect.any(Number)],
      [2, 'pending', 0],
      [3, 'pending', 0],
    ]);

    // the sender's notification log shows the failures
    await sender.goto('/sender/notifications');
    await expect(
      sender.getByTestId('notification').filter({ hasText: created.number }).first(),
    ).toBeVisible();

    await stubMode('ok');
    await expect
      .poll(
        async () =>
          (await stubReceived()).received.filter(
            (r) => r.body.deliveryId === created.id && r.answered === 200,
          ).length,
        { timeout: 60_000 },
      )
      .toBe(3);
    const ok = (await stubReceived()).received.filter(
      (r) => r.body.deliveryId === created.id && r.answered === 200,
    );
    expect(ok.map((r) => r.body.event)).toEqual(['created', 'assigned', 'picked_up']);
    expect(ok.every((r) => r.signatureValid)).toBe(true);
    expect(new Set(ok.map((r) => r.webhookId)).size).toBe(3);
    // the log in the UI is updated and a manual resend works
    await sender.goto('/sender/notifications');
    const first = sender
      .getByTestId('notification')
      .filter({ hasText: created.number })
      .filter({ hasText: 'Delivered' })
      .first();
    await expect(first).toBeVisible();
    await first.getByRole('button', { name: 'Send again' }).click();
    await expect(first.getByRole('status')).toHaveText('Sent.');
  });

  test('the stub that does not answer at all is handled too (timeout, then recovery)', async ({
    world,
    open,
  }) => {
    await stubMode('hang');
    const { sql } = world;
    const d = await createDelivery(sql, { senderId: world.sender.id });
    await assignDelivery(sql, d.id, world.courier.id);
    await expect
      .poll(
        async () =>
          (await stubReceived()).received.filter((r) => r.body.deliveryId === d.id).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1);
    await stubMode('ok');
    await expect
      .poll(
        async () =>
          (await stubReceived()).received
            .filter((r) => r.body.deliveryId === d.id && r.answered === 200)
            .map((r) => r.body.event),
        { timeout: 90_000 },
      )
      .toEqual(['created', 'assigned']);
    void open;
  });
});
