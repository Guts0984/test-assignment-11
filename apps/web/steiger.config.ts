import { defineConfig } from 'steiger';
import fsd from '@feature-sliced/steiger-plugin';

export default defineConfig([
  ...fsd.configs.recommended,
  {
    // Pages here are thin on purpose (Next's own router lives in /app); a slice may be used by one route only.
    files: ['./src/**'],
    rules: {
      'fsd/insignificant-slice': 'off',
      'fsd/public-api': 'off',
      'fsd/no-reserved-folder-names': 'off',
      'fsd/segments-by-purpose': 'off',
      'fsd/repetitive-naming': 'off',
    },
  },
]);
