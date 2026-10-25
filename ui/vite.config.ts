import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The React interface. One bundle serves every surface; the window's
 * `?surface=` query picks which one renders (see src/core/surface.ts).
 *
 * Port 1421 while the Angular interface still owns 1420 during the migration.
 */
export default defineConfig({
  root: here('.'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': here('./src') } },
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: {
    outDir: here('../dist/ui'),
    emptyOutDir: true,
    // WebView2 on Windows and the Android System WebView are both evergreen Chromium.
    target: 'chrome120',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    restoreMocks: true,
  },
});
