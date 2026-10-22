import javascript from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import typescript from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'dist/**',
    'coverage/**',
    'playwright-report/**',
    'blob-report/**',
    'test-results/**',
    '.playwright-mcp/**',
    'playwright/.auth/**',
    '.cache/**',
    '.vite/**',
  ]),
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [javascript.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      javascript.configs.recommended,
      typescript.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['public/notifications.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  prettier,
]);
