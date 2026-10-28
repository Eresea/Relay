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
  // Only the app's own page. Left alone, Vite crawls every *.html under the
  // root as an entry: Rust build output, design prototypes, Umbra's docs.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // `tauri dev` starts this server, then cargo writes tens of thousands of
      // files into src-tauri/target. Watching them held the windows' module
      // requests until the events drained: a blank window that "randomly"
      // came alive. Tauri watches the Rust side itself.
      ignored: ['**/src-tauri/**', '**/docs/**', '**/dist/**'],
    },
    // Transformed before the windows open rather than while they wait.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/features/home/home.tsx',
        './src/features/palette/command-palette.tsx',
        './src/features/hud/hud-surface.tsx',
      ],
    },
  },
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
