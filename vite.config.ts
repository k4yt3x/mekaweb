import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version }: { version: string } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  base: process.env.MEKAWEB_BASE_PATH ?? '/',
  define: { __MEKAWEB_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  // Editors and generators can replace a file in several writes; do not serve a partial module.
  server: {
    watch: { awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 } },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
