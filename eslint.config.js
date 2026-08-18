const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

/**
 * Flat config. The rule set is deliberately small and mostly type-aware:
 * rules that need type information catch the mistakes that actually happen in
 * this codebase (forgotten awaits, unsafe narrowing), whereas stylistic rules
 * would only argue with the formatter.
 */
module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/.vscode-test/**',
      // Generated: an HTML coverage report is not source to be linted.
      '**/coverage/**'
    ]
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      // A dropped promise in an event handler means a capture silently never
      // happens, which is the worst failure mode this extension has.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // no-unnecessary-condition is deliberately absent. Its judgements rest
      // on TypeScript's indexed-access typing, which is unsound: a regex
      // capture group is typed `string` even when the group is optional and
      // did not participate, and an index into a record is typed as present.
      // Every guard it flagged in this codebase is load-bearing, so following
      // its advice would introduce the crashes the guards prevent. The honest
      // alternative, noUncheckedIndexedAccess, costs `?? ''` at ~70 sites
      // where the pattern already guarantees the group matched.

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    // Tests assert on deliberately malformed values, so exhaustive narrowing
    // rules there produce noise rather than signal.
    files: ['src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
