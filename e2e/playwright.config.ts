import { defineConfig, devices } from '@playwright/test';
import { loadTestEnv } from '@courier/db/testing';

loadTestEnv();
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

// The stack (supabase start + docker compose up) must be running. Tests create their own users and never touch seed data.
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
