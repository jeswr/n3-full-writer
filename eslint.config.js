import globals from 'globals';
import tseslint from 'typescript-eslint';

const rules = {
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-constant-condition': 'error',
  eqeqeq: 'error',
  'no-var': 'error',
  'comma-dangle': ['error', 'always-multiline'],
  'no-trailing-spaces': 'error',
  'eol-last': 'error',
};

export default [
  { ignores: ['coverage/**', 'dist/**', 'node_modules/**'] },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    rules: {
      ...rules,
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['test/**'],
    languageOptions: { globals: globals.jest },
  },
  {
    // Type tests declare values only to check their types.
    files: ['test/types/**'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
];
