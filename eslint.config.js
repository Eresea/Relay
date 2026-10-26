// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      // Vendored subtree with its own conventions.
      'packages/umbra/**',
      // Throwaway design prototypes, rendered to PNG; not app code.
      'docs/design/prototype/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylistic,
    ],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The classic hook rules only. The React Compiler rules assume state is
      // immutable and owned by React; Relay's components read signal-holding
      // objects (lib/signals.ts) that change in place, which those rules
      // misreport, and the compiler itself is not used.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Tests read mocks off a class-typed bridge and stub jsdom gaps with no-ops.
    files: ['src/**/*.spec.{ts,tsx}', 'src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
);
