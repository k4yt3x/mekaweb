import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version }: { version: string } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

// The dev server passes Meka Studio's API and Meka's to a running Meka Studio, whose public_origin
// is the dev server's address, so its cookie and Origin check work as they do in production.
const gateway = process.env.MEKA_STUDIO_GATEWAY ?? 'http://127.0.0.1:4180';

export default defineConfig({
  base: '/',
  define: { __MEKA_STUDIO_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  server: {
    // Editors and generators can replace a file in several writes; do not serve a partial module.
    watch: { awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 } },
    proxy: {
      '/api': { target: gateway, ws: true },
      '/meka': { target: gateway },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
