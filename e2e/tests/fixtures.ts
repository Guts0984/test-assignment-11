import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { createSql } from '@courier/db';
import { createProfiled, openShift, testEnv, type TestUser } from '@courier/db/testing';

export const STUB = process.env.E2E_STUB_URL ?? 'http://localhost:5000';
const env = () => testEnv();

/** A real 1×1 JPEG, so <img> really decodes it (the API only checks magic bytes, the browser checks the rest). */
export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
  'base64',
);

export type World = {
  sender: TestUser;
  dispatcher: TestUser;
  courier: TestUser;
  courier2: TestUser;
  courierName: string;
  courier2Name: string;
  sql: ReturnType<typeof createSql>;
};

async function makeWorld(): Promise<World> {
  const sql = createSql({ url: env().databaseUrl, max: 4 });
  const sender = await createProfiled(sql, 'sender');
  // the API runs in a container: the stub is reachable there as "sender-stub"
  await sql`update public.sender_webhooks set url = 'http://sender-stub:5000/hook', secret = 'whsec_demo_change_me' where sender_id = ${sender.id}`;
  const dispatcher = await createProfiled(sql, 'dispatcher');
  const tag = Math.random().toString(36).slice(2, 10);
  const courierName = `Kurier Alpha ${tag}`;
  const courier2Name = `Kurier Beta ${tag}`;
  const courier = await createProfiled(sql, 'courier', { name: courierName });
  const courier2 = await createProfiled(sql, 'courier', { name: courier2Name });
  await openShift(sql, courier.id);
  await openShift(sql, courier2.id);
  return { sender, dispatcher, courier, courier2, courierName, courier2Name, sql };
}

type Fx = {
  world: World;
  /** Opens a page in its own browser context (its own cookies = its own login). Browser-console errors fail the test. */
  open: (opts?: { mobile?: boolean; locale?: 'en' | 'uk' }) => Promise<Page>;
};

export const test = base.extend<Fx>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures object pattern here
  world: async ({}, use) => {
    const w = await makeWorld();
    await use(w);
    await w.sql.end({ timeout: 2 });
  },
  open: async ({ browser }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    await use(async (opts = {}) => {
      const ctx = await newContext(browser, opts);
      contexts.push(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        // a deliberately offline browser and deliberately refused requests log network errors (Next also logs that it fell back
        // to a normal page load when its background fetch fails offline): not application bugs
        if (
          /Failed to load resource|net::ERR|ERR_INTERNET_DISCONNECTED|status of 4\d\d|favicon|Failed to fetch RSC payload/i.test(
            text,
          )
        )
          return;
        errors.push(`console.error: ${text}`);
      });
      return page;
    });
    for (const c of contexts) await c.close();
    if (errors.length)
      testInfo.annotations.push({ type: 'console-errors', description: errors.join('\n') });
    expect(errors, 'the browser console must stay clean').toEqual([]);
  },
});

async function newContext(browser: Browser, opts: { mobile?: boolean; locale?: 'en' | 'uk' }) {
  const ctx = await browser.newContext({
    ...(opts.mobile
      ? {
          viewport: { width: 360, height: 640 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
        }
      : { viewport: { width: 1280, height: 800 } }),
    serviceWorkers: 'allow',
  });
  const base = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3000');
  if (opts.locale)
    await ctx.addCookies([
      { name: 'NEXT_LOCALE', value: opts.locale, domain: base.hostname, path: '/' },
    ]);
  return ctx;
}

export async function login(
  page: Page,
  user: { email: string; password: string },
  expectUrl: RegExp,
) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(expectUrl);
}

export async function createDeliveryViaForm(
  page: Page,
  over: { weight?: string; cod?: string } = {},
) {
  await page.goto('/sender/new');
  await page.getByLabel('Full name').fill('Olena Kovalenko');
  await page.getByLabel('Phone').fill('0671234567');
  await page.getByLabel('City').fill('Kyiv');
  await page.getByLabel('Street').fill('Khreshchatyk');
  await page.getByLabel('House').fill('22');
  await page.getByLabel('Weight, kg').fill(over.weight ?? '1,5');
  if (over.cod) await page.getByLabel('Cash on delivery, ₴').fill(over.cod);
  await expect(page.getByTestId('quote')).toBeVisible();
  await page.getByRole('button', { name: 'Create delivery' }).click();
  await expect(page).toHaveURL(/\/sender\/[0-9a-f-]{36}\?created=1/);
  const number = (await page.getByTestId('number').textContent())!.trim();
  const href = await page.locator('a[href^="/track/"]').getAttribute('href');
  return { number, trackingPath: href!, id: page.url().match(/sender\/([0-9a-f-]{36})/)![1]! };
}

export async function assignViaCard(page: Page, deliveryId: string, courierName: string) {
  await page.goto(`/dispatcher/deliveries/${deliveryId}`);
  await page.getByRole('button', { name: 'Assign' }).click();
  await page.getByRole('radio', { name: new RegExp(courierName) }).check();
  await page.getByRole('button', { name: 'Assign', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

export async function stubReceived(): Promise<{
  mode: string;
  received: {
    webhookId: string;
    signatureValid: boolean;
    answered: number | 'hung';
    body: { event: string; deliveryId: string; number: string };
  }[];
}> {
  return (await fetch(`${STUB}/api/received`)).json() as never;
}
export const stubMode = (mode: 'ok' | 'error' | 'hang') =>
  fetch(`${STUB}/api/mode`, { method: 'POST', body: JSON.stringify({ mode }) });

export { expect };
