import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: process.env.MEKAWEB_BASE_PATH ?? '/',
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
