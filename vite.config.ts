import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Relay's interface. One bundle serves every surface; the window's
 * `?surface=` query picks which one renders (see src/core/surface.ts).
 * Tauri's dev build expects the server on 1420 (src-tauri/tauri.conf.json).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': here('./src') } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // WebView2 on Windows and the Android System WebView are both evergreen Chromium.
    target: 'chrome120',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
