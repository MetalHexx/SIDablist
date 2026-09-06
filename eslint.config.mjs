// @ts-check
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

// Vendored trees keep upstream style; only stylistic preference rules are waived there.
const stylisticRulesOff = Object.fromEntries(
  Object.keys(tseslint.configs.stylistic.at(-1).rules).map((rule) => [rule, 'off']),
);

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**'],
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended, tseslint.configs.stylistic],
    plugins: {
      'import-x': importX,
    },
    rules: {
      'import-x/extensions': ['error', 'ignorePackages', { ts: 'never', js: 'always' }],
    },
  },
  {
    files: ['libs/core/**/*.ts'],
    ignores: ['libs/core/src/vendor/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'core takes environment through an injected port' },
        { name: 'document', message: 'core takes environment through an injected port' },
        { name: 'navigator', message: 'core takes environment through an injected port' },
        {
          name: 'localStorage',
          message: 'core holds values; the application decides what persists',
        },
      ],
    },
  },
  {
    files: ['libs/core/src/vendor/**/*.ts'],
    rules: stylisticRulesOff,
  },
);
