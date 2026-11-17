import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/shared/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@courier/shared'],
  poweredByHeader: false,
  // linting runs from the repository root (eslint + steiger), not inside `next build`
  eslint: { ignoreDuringBuilds: true },
  reactStrictMode: true,
  // the monorepo root, so the standalone output includes workspace packages
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
};

export default withNextIntl(config);
