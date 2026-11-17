import { defineConfig } from 'vitest/config';

// These tests talk to a real local Supabase (`pnpm supabase start`). They run one file at a time:
// several tests assert global properties (gapless numbering, exact counts) and must not interleave.
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
