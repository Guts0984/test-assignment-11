import {
  createDelivery,
  assignDelivery,
  pickUpDelivery,
  driveTo,
  quickCourier,
} from '@courier/db/testing';
import { test, expect, login, createDeliveryViaForm, JPEG } from './fixtures';

test.describe('login and role guards', () => {
  test('empty and wrong credentials are explained; each role lands in its own area', async ({
    world,
    open,
  }) => {
    const page = await open();
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('This field is required')).toHaveCount(2);
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Wrong email or password.' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    for (const [user, area] of [
      [world.sender, /\/sender$/],
      [world.dispatcher, /\/dispatcher$/],
      [world.courier, /\/courier$/],
    ] as const) {
      const p = await open();
      await login(p, user, area);
    }
  });

  test('a role cannot open another role’s pages by URL, and logging out really ends the session', async ({
    world,
    open,
  }) => {
    const page = await open();
    await page.goto('/sender');
    await expect(page).toHaveURL(/\/login$/); // not signed in
    await login(page, world.sender, /\/sender$/);
    for (const forbidden of ['/dispatcher', '/dispatcher/report', '/courier']) {
      await page.goto(forbidden);
      await expect(page).toHaveURL(/\/sender$/);
    }
    await page.goto('/login');
    await expect(page).toHaveURL(/\/sender$/); // already signed in
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/); // "Back" does not show the previous user's data
    await expect(page.getByTestId('total')).toHaveCount(0);
    await page.goto('/sender/new');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('sender: the create form', () => {
  test('every invalid field shows its own message, the first is focused, a fix clears it, and nothing is saved', async ({
    world,
    open,
  }) => {
    const page = await open();
    await login(page, world.sender, /\/sender$/);
    await page.goto('/sender/new');
    await page.getByRole('button', { name: 'Create delivery' }).click();
    for (const label of ['Full name', 'Phone', 'City', 'Street', 'House', 'Weight, kg']) {
      const f = page.getByLabel(label);
      await expect(f).toHaveAttribute('aria-invalid', 'true');
      await expect(f).toHaveAccessibleDescription('This field is required');
    }
    await expect(page.getByLabel('Full name')).toBeFocused();
    await page.getByLabel('Phone').fill('12');
    await page.getByLabel('Weight, kg').fill('31');
    await page.getByLabel('Cash on delivery, ₴').fill('lots');
    await page.getByRole('button', { name: 'Create delivery' }).click();
    await expect(page.getByText('Enter a phone number like +380 67 123 45 67')).toBeVisible();
    await expect(page.getByText('Weight must be between 0.001 and 30 kg')).toBeVisible();
    await expect(page.getByLabel('Cash on delivery, ₴')).toHaveAccessibleDescription(/not valid/);
    await page.getByLabel('Weight, kg').fill('2');
    await page.getByLabel('Weight, kg').blur();
    await expect(page.getByText('Weight must be between 0.001 and 30 kg')).toHaveCount(0);
    const [n] = await world.sql<
      { n: number }[]
    >`select count(*)::int n from public.deliveries where sender_id = ${world.sender.id}`;
    expect(n!.n).toBe(0);
  });

  test('the price follows the form, uses the server’s tariff, and switches with the language', async ({
    world,
    open,
  }) => {
    const page = await open();
    await login(page, world.sender, /\/sender$/);
    await page.goto('/sender/new');
    await expect(page.getByText('Enter the zone and weight to see the price.')).toBeVisible();
    await page.getByLabel('Weight, kg').fill('1,5');
    await expect(page.getByTestId('quote-total')).toHaveText('₴68.00'); // zone A: 60 + 8 for the 2nd kilogram
    await page.getByLabel('Zone').selectOption('C');
    await expect(page.getByTestId('quote-total')).toHaveText('₴118.00'); // 110 + 8
    await page.getByLabel('Cash on delivery, ₴').fill('1234,50');
    await expect(page.getByTestId('quote-total')).toHaveText('₴142.69'); // 118 + 2 % of 1234.50 = 24.69
    await page.getByRole('button', { name: 'UK' }).click();
    await expect(page.getByRole('button', { name: 'Створити доставку' })).toBeVisible();
    await expect(page.getByTestId('quote-total')).toHaveText(/142,69\s₴/);
    await expect(page.locator('body')).not.toContainText(
      /\b(create|errors|form|list)\.[a-zA-Z_]+\b/,
    ); // no raw message keys
  });

  test('works with the keyboard only, and a double submit creates exactly one delivery', async ({
    world,
    open,
  }) => {
    const page = await open();
    await login(page, world.sender, /\/sender$/);
    await page.goto('/sender/new');
    await page.getByLabel('Full name').focus();
    await page.keyboard.type('Olena Kovalenko');
    for (const text of ['+380671234567', 'Kyiv']) {
      await page.keyboard.press('Tab');
      await page.keyboard.type(text);
    }
    await page.keyboard.press('Tab'); // city → street
    await page.keyboard.type('Khreshchatyk');
    await page.keyboard.press('Tab');
    await page.keyboard.type('22');
    await page.getByLabel('Weight, kg').focus();
    await page.keyboard.type('1');
    await expect(page.getByTestId('quote')).toBeVisible();
    // two Enter presses in a row: the second must not create a second delivery
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/sender\/[0-9a-f-]{36}\?created=1/);
    await page.waitForTimeout(500);
    const [n] = await world.sql<
      { n: number }[]
    >`select count(*)::int n from public.deliveries where sender_id = ${world.sender.id}`;
    expect(n!.n).toBe(1);
  });
});

test.describe('sender: list, filters and URL state', () => {
  test('filters live in the URL: reload keeps them, Back restores the previous ones, search and paging work', async ({
    world,
    open,
  }) => {
    const { sql } = world;
    const made = [];
    for (let i = 0; i < 25; i++)
      made.push(
        await createDelivery(sql, {
          senderId: world.sender.id,
          phone: i % 5 === 0 ? '+380509990000' : '+380671110000',
        }),
      );
    await driveTo(sql, made[0]!.id, world.courier.id, 'delivered');
    await sql`update public.deliveries set status = 'cancelled', courier_id = null where id = ${made[1]!.id}`;

    const page = await open();
    await login(page, world.sender, /\/sender$/);
    await expect(page.getByTestId('total')).toHaveText('25 deliveries found');
    await expect(page.getByTestId('page-info')).toHaveText('Page 1 of 2');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole('row')).toHaveCount(1 + 5); // header + the last 5
    await page.goBack();
    await expect(page.getByTestId('page-info')).toHaveText('Page 1 of 2');

    await page.getByLabel('Cancelled').check();
    await expect(page).toHaveURL(/status=cancelled/);
    await expect(page.getByTestId('total')).toHaveText('1 delivery found'); // singular
    await page.reload();
    await expect(page.getByLabel('Cancelled')).toBeChecked();
    await expect(page.getByTestId('total')).toHaveText('1 delivery found');
    await page.goBack();
    await expect(page).not.toHaveURL(/status=cancelled/);
    await expect(page.getByTestId('total')).toHaveText('25 deliveries found');
    await page.goForward();
    await expect(page.getByLabel('Cancelled')).toBeChecked();

    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page).not.toHaveURL(/status=/);
    await page.getByLabel('Number or phone').fill(made[7]!.publicNumber);
    await page.getByLabel('Number or phone').press('Enter');
    await expect(page).toHaveURL(/q=DLV-/);
    await expect(page.getByTestId('total')).toHaveText('1 delivery found');
    await page.getByLabel('Number or phone').fill('+380509990000');
    await page.getByLabel('Number or phone').press('Enter');
    await expect(page.getByTestId('total')).toHaveText('5 deliveries found');
    await page.getByLabel('Number or phone').fill('nothing like this');
    await page.getByLabel('Number or phone').press('Enter');
    await expect(page.getByText('No deliveries match these filters.')).toBeVisible();

    await page.getByRole('button', { name: 'UK' }).click();
    await page.getByRole('button', { name: 'Скинути' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.getByTestId('total')).toHaveText('25 доставок знайдено');
    await page.getByLabel('Скасовано').check();
    await expect(page.getByTestId('total')).toHaveText('1 доставку знайдено');
  });

  test('the sender sees a status change made by someone else without reloading', async ({
    world,
    open,
  }) => {
    const { sql } = world;
    const d = await createDelivery(sql, { senderId: world.sender.id });
    const page = await open();
    await login(page, world.sender, /\/sender$/);
    const row = page.getByRole('row').filter({ hasText: d.publicNumber });
    await expect(row.locator('[data-status]')).toHaveText('Created');
    await assignDelivery(sql, d.id, world.courier.id);
    await expect(row.locator('[data-status]')).toHaveText('Assigned');
    await pickUpDelivery(sql, d.id, world.courier.id);
    await expect(row.locator('[data-status]')).toHaveText('Picked up');
  });

  test('the sender can cancel before pickup, and not after', async ({ world, open }) => {
    const page = await open();
    await login(page, world.sender, /\/sender$/);
    const a = await createDeliveryViaForm(page);
    await page.getByRole('button', { name: 'Cancel delivery' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel delivery' }).click();
    await expect(page.locator('[data-status="cancelled"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel delivery' })).toHaveCount(0);
    const d = await createDelivery(world.sql, { senderId: world.sender.id });
    await assignDelivery(world.sql, d.id, world.courier.id);
    await pickUpDelivery(world.sql, d.id, world.courier.id);
    await page.goto(`/sender/${d.id}`);
    await expect(page.getByRole('button', { name: 'Cancel delivery' })).toHaveCount(0);
    void a;
  });
});

test.describe('dispatcher', () => {
  test('keyboard-only assignment, and every refusal is explained', async ({ world, open }) => {
    const { sql } = world;
    const d = await createDelivery(sql, { senderId: world.sender.id });
    // courier 2 is full (8 active); a third courier has no open shift
    for (let i = 0; i < 8; i++) {
      const x = await createDelivery(sql, { senderId: world.sender.id });
      await assignDelivery(sql, x.id, world.courier2.id);
    }
    const closedCourier = await quickCourier(sql, { shift: false });
    await sql`update public.profiles set full_name = ${'Kurier Closed ' + world.courierName.slice(-8)} where user_id = ${closedCourier}`;

    const page = await open();
    await login(page, world.dispatcher, /\/dispatcher$/);
    await page.goto(`/dispatcher/deliveries/${d.id}`);
    await page.getByRole('button', { name: 'Assign' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const pick = async (name: string) =>
      dialog.getByRole('radio', { name: new RegExp(name) }).check();
    await pick(world.courier2Name);
    await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The courier already has 8 deliveries.');
    await pick('Kurier Closed ' + world.courierName.slice(-8));
    await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText("The courier's shift is closed.");
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Assign' })).toBeFocused(); // focus returns to where it was

    await page.keyboard.press('Enter');
    await dialog.getByRole('radio', { name: new RegExp(world.courierName) }).focus();
    await page.keyboard.press('Space');
    // a radio group is one tab stop: Tab → "Close", Tab → "Assign"
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-status="assigned"]').first()).toBeVisible();
    // assigned to someone else already → a second assignment is refused, explicit reassignment works
    const other = await open();
    await login(other, world.dispatcher, /\/dispatcher$/);
    await other.goto(`/dispatcher/deliveries/${d.id}`);
    await other.getByRole('button', { name: 'Assign' }).click();
    await expect(
      other
        .getByRole('dialog')
        .getByText('This delivery is already assigned. Choosing another courier reassigns it.'),
    ).toBeVisible();
  });

  test('closing a shift shows the expected cash, records a short hand-in, and the report shows it (period in the URL)', async ({
    world,
    open,
  }) => {
    const { sql } = world;
    const [shift] = await sql<
      { id: string }[]
    >`select id from public.shifts where courier_id = ${world.courier.id} and closed_at is null`;
    for (const cod of [100_000, 25_050]) {
      const d = await createDelivery(sql, { senderId: world.sender.id, codKop: cod });
      await driveTo(sql, d.id, world.courier.id, 'delivered');
      await sql`update public.deliveries set delivered_shift_id = ${shift!.id} where id = ${d.id}`;
    }
    const page = await open();
    await login(page, world.dispatcher, /\/dispatcher$/);
    await page.getByRole('button', { name: `Close shift of ${world.courierName}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('expected-cash')).toHaveText('₴1,250.50');
    await dialog.getByRole('button', { name: 'Close shift' }).click();
    await expect(dialog.getByText('This field is required')).toBeVisible();
    await dialog.getByLabel('Cash handed in, ₴').fill('1200');
    await dialog.getByRole('button', { name: 'Close shift' }).click();
    await expect(dialog.getByTestId('discrepancy')).toHaveText('-₴50.50');
    await expect(dialog.getByText('The discrepancy was recorded.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(
      page
        .getByTestId('courier-row')
        .filter({ hasText: world.courierName })
        .getByText('Shift closed'),
    ).toBeVisible();

    const today = new Date().toISOString().slice(0, 10);
    await page.goto(`/dispatcher/report?from=${today}&to=${today}`);
    await expect(page.getByTestId('report')).toContainText(world.courierName);
    await expect(page.getByTestId('report')).toContainText('-₴50.50');
    await expect(page.getByLabel('From')).toHaveValue(today);
    await page.getByLabel('From').fill('2026-01-01');
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page).toHaveURL(/from=2026-01-01/);
    await page.reload();
    await expect(page.getByLabel('From')).toHaveValue('2026-01-01');
  });
});

test.describe('recipient tracking page', () => {
  test('shows no phone, house or apartment, explains an invalid link, and is translated', async ({
    world,
    open,
  }) => {
    const d = await createDelivery(world.sql, { senderId: world.sender.id, codKop: 5000 });
    const page = await open();
    await page.goto(`/track/${d.trackingToken}`);
    await expect(page.getByTestId('tr-number')).toHaveText(d.publicNumber);
    const text = (await page.locator('body').innerText()) + (await page.content());
    for (const leak of ['+380671234567', '380671234567', '0671234567', 'Test Recipient'])
      expect(text).not.toContain(leak);
    await expect(page.getByText('+380 ••••••• 67')).toBeVisible();
    await expect(page.getByText('Kyiv, Test St')).toBeVisible();
    await page.getByRole('button', { name: 'UK' }).click();
    await expect(page.getByText('Ваш код отримання')).toBeVisible();
    await expect(page.getByTestId('tr-amount')).toHaveText(/50,00\s₴/);

    await page.goto('/track/aaaaaaaaaaaaaaaaaaaaaa');
    await expect(page.getByText('Це посилання для відстеження недійсне.')).toBeVisible();
  });
});

test.describe('courier phone (360 px)', () => {
  test('a refused handover stays visible, in the user’s language, until dismissed — also after a reload', async ({
    world,
    open,
  }) => {
    const { sql } = world;
    const d = await createDelivery(sql, { senderId: world.sender.id, codKop: 1000 });
    await assignDelivery(sql, d.id, world.courier.id);
    await pickUpDelivery(sql, d.id, world.courier.id);
    const phone = await open({ mobile: true });
    await login(phone, world.courier, /\/courier$/);
    await phone.getByRole('button', { name: 'UK' }).click();
    await expect(phone.getByRole('button', { name: 'Вручив', exact: true }).first()).toBeVisible();
    const card = phone.getByTestId('delivery').filter({ hasText: d.publicNumber });
    await card.getByRole('button', { name: 'Вручив', exact: true }).click();
    const dialog = phone.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Підтвердити вручення' }).click();
    await expect(dialog.getByText("Це поле обов'язкове")).toBeVisible();
    await expect(dialog.getByText('Потрібне фото')).toBeVisible();
    await dialog.getByLabel('Код отримувача').fill('123');
    await dialog.getByRole('button', { name: 'Підтвердити вручення' }).click();
    await expect(dialog.getByText('Введіть 6-значний код')).toBeVisible();
    await dialog.getByLabel('Код отримувача').fill(d.code === '123456' ? '654321' : '123456');
    await dialog
      .getByLabel('Фото вручення')
      .setInputFiles({ name: 'p.jpg', mimeType: 'image/jpeg', buffer: JPEG });
    await dialog.getByRole('button', { name: 'Підтвердити вручення' }).click();
    const rej = phone.getByTestId('rejected-item');
    await expect(rej).toContainText('Невірний код. Залишилось спроб: 4.');
    await phone.reload();
    await expect(phone.getByTestId('rejected-item')).toContainText('Невірний код');
    expect(
      await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await phone.getByTestId('rejected-item').getByRole('button', { name: 'Закрити' }).click();
    await expect(phone.getByTestId('rejected')).toHaveCount(0);
  });
});
