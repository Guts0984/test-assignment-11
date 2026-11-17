import type { Page } from '@playwright/test';
import { createDelivery, assignDelivery } from '@courier/db/testing';
import { test, expect, login } from './fixtures';

// Regression tests for the findings of the second audit. Each one reproduces the exact user-visible failure.

/** Signs out; when the app warns about unsent actions, confirms ("Sign out anyway"). */
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Sign out anyway' });
  if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click();
}

test.describe('dispatcher: two colleagues, one delivery', () => {
  test('a second dispatcher does not silently override the first one’s assignment', async ({
    world,
    open,
  }) => {
    const { sql } = world;
    const d = await createDelivery(sql, { senderId: world.sender.id });
    const first = await open();
    await login(first, world.dispatcher, /\/dispatcher$/);
    await first.goto(`/dispatcher/deliveries/${d.id}`);
    await first.getByRole('button', { name: 'Assign' }).click();
    const dialog = first.getByRole('dialog');
    await dialog.getByRole('radio', { name: new RegExp(world.courier2Name) }).check();

    // meanwhile a colleague assigns it to someone else (the first dispatcher's page updates live behind the dialog)
    await assignDelivery(sql, d.id, world.courier.id, world.dispatcher.id);
    await expect(first.locator('[data-status="assigned"]').first()).toBeVisible();
    await expect(dialog.getByText('Choosing another courier reassigns it.')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('This delivery is already assigned.');
    const [row] = await sql`select courier_id from public.deliveries where id = ${d.id}`;
    expect(row!.courier_id).toBe(world.courier.id); // the colleague's assignment stands
    const types = (
      await sql`select type from public.delivery_events where delivery_id = ${d.id} order by id`
    ).map((e) => e.type);
    expect(types).toEqual(['created', 'assigned']); // no hidden "reassigned"
  });
});

test.describe('filters and the report are usable with the keyboard', () => {
  test('a date typed with the keyboard is applied once, whole, and the input keeps it', async ({
    world,
    open,
  }) => {
    const page = await open();
    await login(page, world.sender, /\/sender$/);
    const history = await page.evaluate(() => window.history.length);
    await page.getByLabel('From').click();
    await page.keyboard.type('10012026'); // MM DD YYYY in the browser's en-US field
    await expect(page).toHaveURL(/from=2026-10-01/);
    await expect(page.getByLabel('From')).toHaveValue('2026-10-01');
    expect(page.url()).not.toContain('0002');
    const added = (await page.evaluate(() => window.history.length)) - history;
    expect(added).toBeLessThanOrEqual(1); // no junk history entries
    await page.getByLabel('To').click();
    await page.keyboard.type('12312026');
    await expect(page).toHaveURL(/from=2026-10-01&to=2026-12-31/); // From is not lost when To is set
  });

  test('after Back the report inputs show the same period as the figures', async ({
    world,
    open,
  }) => {
    const page = await open();
    await login(page, world.dispatcher, /\/dispatcher$/);
    await page.goto('/dispatcher/report?from=2026-01-01&to=2026-01-31');
    await expect(page.getByLabel('From')).toHaveValue('2026-01-01');
    await page.getByLabel('From').fill('2026-02-01');
    await page.getByLabel('To').fill('2026-02-28');
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page).toHaveURL(/from=2026-02-01/);
    await page.goBack();
    await expect(page).toHaveURL(/from=2026-01-01/);
    await expect(page.getByLabel('From')).toHaveValue('2026-01-01');
    await expect(page.getByLabel('To')).toHaveValue('2026-01-31');
  });
});

test.describe('sender create form: connection problems', () => {
  async function fill(page: Page, weight = '1,5') {
    await page.goto('/sender/new');
    await page.getByLabel('Full name').fill('Olena Kovalenko');
    await page.getByLabel('Phone').fill('0671234567');
    await page.getByLabel('City').fill('Kyiv');
    await page.getByLabel('Street').fill('Khreshchatyk');
    await page.getByLabel('House').fill('22');
    await page.getByLabel('Weight, kg').fill(weight);
    await expect(page.getByTestId('quote')).toBeVisible();
  }

  test('offline: the user is told at once, nothing hangs, the input is kept', async ({
    world,
    open,
  }) => {
    const page = await open();
    await login(page, world.sender, /\/sender$/);
    await fill(page);
    await page.context().setOffline(true);
    const started = Date.now();
    await page.getByRole('button', { name: 'Create delivery' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'No connection to the server.' }),
    ).toBeVisible();
    expect(Date.now() - started).toBeLessThan(4000);
    await expect(page.getByRole('button', { name: 'Create delivery' })).toBeEnabled();
    await expect(page.getByLabel('Full name')).toHaveValue('Olena Kovalenko');
    await page.context().setOffline(false);
    await page.getByRole('button', { name: 'Create delivery' }).click();
    await expect(page).toHaveURL(/\/sender\/[0-9a-f-]{36}\?created=1/);
  });

  test('the server created the delivery but the answer was lost: a corrected retry points to it, no duplicate', async ({
    world,
    open,
  }) => {
    const page = await open();
    await login(page, world.sender, /\/sender$/);
    await fill(page);
    let dropped = false;
    await page.route(/\/deliveries$/, async (route) => {
      if (route.request().method() === 'POST' && !dropped) {
        dropped = true;
        await route.fetch(); // the request reaches the server and is processed...
        await route.abort('failed'); // ...but the browser never gets the answer
        return;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Create delivery' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await page.getByLabel('Weight, kg').fill('2'); // the user changes something and tries again
    await page.getByRole('button', { name: 'Create delivery' }).click();
    // the message may be an info status or an alert; the link points to ONE delivery (a uuid), unlike the header nav
    const link = page.locator(
      'a[href^="/sender/"]:not([href="/sender/new"]):not([href="/sender/notifications"]):not([href="/sender/settings"])',
    );
    await expect(link).toBeVisible(); // "your earlier attempt already created it" with a way to open it
    const [n] = await world.sql<
      { n: number }[]
    >`select count(*)::int n from public.deliveries where sender_id = ${world.sender.id}`;
    expect(n!.n).toBe(1);
    await link.click();
    await expect(page.getByTestId('number')).toHaveText(/^DLV-\d{6}$/);
  });
});

test.describe('dispatcher board: a new delivery is findable', () => {
  test('with "newest first" a fresh delivery shows up even though hundreds are waiting', async ({
    world,
    open,
  }) => {
    const d = await createDelivery(world.sql, { senderId: world.sender.id, zone: 'C' });
    const page = await open();
    await login(page, world.dispatcher, /\/dispatcher$/);
    // oldest first (the default): not among the first 25
    await expect(page.getByTestId('queue-item').filter({ hasText: d.publicNumber })).toHaveCount(0);
    await page.goto('/dispatcher?order=newest');
    await expect(
      page.getByTestId('zone-C').getByTestId('queue-item').filter({ hasText: d.publicNumber }),
    ).toBeVisible();
  });
});

test.describe('courier on a shared phone', () => {
  test('one courier’s waiting action is never sent under the next courier’s account', async ({
    world,
    open,
  }) => {
    const { sql } = world;
    const d = await createDelivery(sql, { senderId: world.sender.id });
    await assignDelivery(sql, d.id, world.courier.id);

    const phone = await open({ mobile: true });
    await login(phone, world.courier, /\/courier$/);
    const card = phone.getByTestId('delivery').filter({ hasText: d.publicNumber });
    await expect(card).toBeVisible();
    await expect
      .poll(() => phone.evaluate(async () => !!(await caches.match('/courier'))))
      .toBe(true);
    await phone.context().setOffline(true);
    await card.getByRole('button', { name: 'Picked up' }).click();
    await expect(phone.getByTestId('waiting')).toHaveText('1 action waiting to be sent');
    await signOut(phone); // still offline: the courier is warned about the waiting action, confirms, and is signed out
    await expect(phone).toHaveURL(/\/login$/);
    await phone.context().setOffline(false);

    await login(phone, world.courier2, /\/courier$/); // the next courier signs in on the same phone
    await expect(phone.getByTestId('waiting')).toHaveText('Everything is sent'); // not "1 action waiting"
    await expect(phone.getByTestId('rejected')).toHaveCount(0);
    await phone.waitForTimeout(3000);
    const [still] = await sql`select status from public.deliveries where id = ${d.id}`;
    expect(still!.status).toBe('assigned'); // courier 1's pickup was NOT sent as courier 2
    expect(
      await sql`select 1 from public.courier_actions where delivery_id = ${d.id}`,
    ).toHaveLength(0);
    // the cached delivery list of courier 1 is not shown to courier 2
    await expect(phone.getByTestId('delivery').filter({ hasText: d.publicNumber })).toHaveCount(0);

    // courier 1 signs back in: their own queue is intact and goes out under their own account
    await signOut(phone);
    await expect(phone).toHaveURL(/\/login$/);
    await login(phone, world.courier, /\/courier$/);
    await expect(phone.getByTestId('waiting')).toHaveText('Everything is sent', {
      timeout: 30_000,
    });
    await expect
      .poll(
        async () => (await sql`select status from public.deliveries where id = ${d.id}`)[0]!.status,
        {
          timeout: 30_000,
        },
      )
      .toBe('picked_up');
  });
});
