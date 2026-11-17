import { defineConfig } from 'vitest/config';

// Integration tests start a real Nest server against the real local Supabase database; one file at a time
// because several tests assert global properties (gapless numbers) and abuse tests saturate the server.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // global-teardown.ts is a globalSetup file that only exports teardown() (vitest has no separate option)
    globalSetup: ['tests/global-setup.ts', 'tests/global-teardown.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
