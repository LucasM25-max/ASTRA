import { defineConfig } from 'vitest/config';

/**
 * Vite configuration for ASTRA.
 *
 * `defineConfig` is imported from `vitest/config` (a superset of Vite's own
 * helper) so the `test` block below is type-checked as well.
 */
export default defineConfig({
  // Relative base keeps the built bundle portable (sub-path hosting, file:// preview).
  base: './',

  server: {
    // Bind to every interface so the sandbox/browser preview can reach the dev server.
    host: true,
    port: 5173,
    strictPort: false,
    // The preview proxy reaches us through a generated hostname, which is not
    // "localhost" - allow it instead of letting Vite reject the request.
    allowedHosts: true,
  },

  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
  },

  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // Three.js is a large dependency; the default 500 kB warning is noise here.
    chunkSizeWarningLimit: 1200,
  },

  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
