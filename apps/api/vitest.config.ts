import { defineConfig } from 'vitest/config';

// Integration tests start a real Nest server against the real local Supabase database; one file at a time
// because several tests assert global properties (gapless numbers) and abuse tests saturate the server.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
