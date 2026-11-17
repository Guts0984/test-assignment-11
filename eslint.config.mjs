import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

const noClasses = [
  'error',
  {
    selector: 'ClassDeclaration, ClassExpression',
    message:
      'Classes are only allowed in NestJS building blocks (apps/api/src outside domain/). Use functions.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/next-env.d.ts',
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      'supabase/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': noClasses,
    },
  },
  {
    // NestJS building blocks may use classes (decorators need them).
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/domain/**', 'apps/api/src/**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
);
