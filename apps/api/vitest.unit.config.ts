import { defineConfig } from 'vitest/config';

// Pure unit tests: no database, no network.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
