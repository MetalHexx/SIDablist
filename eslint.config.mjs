// @ts-check
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

// Vendored trees keep upstream style; only stylistic preference rules are waived there.
// `tseslint.configs.stylistic` is itself an array of config objects (its own base config plus
// the eslint-recommended overrides it depends on) - reading only the last one misses stylistic
// rules those earlier objects turn on, such as `prefer-const`.
const stylisticRulesOff = Object.fromEntries(
  tseslint.configs.stylistic
    .flatMap((config) => Object.keys(config.rules ?? {}))
    .map((rule) => [rule, 'off']),
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
    files: ['libs/core/**/*.ts', 'libs/analysis/**/*.ts', 'libs/tunes/**/*.ts'],
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
    // Core and the ASID sink read no clock, write to no console and build no worker: the host
    // supplies a `TimeSource`, an `EngineLog` and a worker factory. `Worker` the type stays usable
    // (the factory's signature), so only its construction is banned. Flat config replaces a rule's
    // options in a later matching block, so the four browser names are repeated here.
    files: ['libs/core/src/**/*.ts', 'libs/asid/src/**/*.ts'],
    ignores: ['**/*.spec.ts', 'libs/core/src/testing/**', 'libs/asid/src/web-midi/**'],
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
        { name: 'console', message: 'report through the injected EngineLog' },
        { name: 'performance', message: 'read time through the injected TimeSource' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Worker']",
          message: 'the host makes the worker and passes a factory',
        },
      ],
    },
  },
  {
    files: ['libs/core/src/vendor/**/*.ts'],
    rules: stylisticRulesOff,
  },
);
