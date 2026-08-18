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

      // Catches guards that can never fire, which in parsing code usually
      // means a condition written against the wrong assumption. This is only
      // trustworthy because capture groups go through the Captures accessor
      // in errorExtract.ts: read straight off a RegExpMatchArray, TypeScript
      // types every group as `string` and the rule would demand the removal
      // of guards that are load-bearing.
      '@typescript-eslint/no-unnecessary-condition': 'error',

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
