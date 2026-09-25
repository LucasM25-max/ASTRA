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
    // The default 500 kB warning is noise for a 3D app, but it is not noise
    // for the real number: Rapier's *compat* build inlines its ~3 MB WASM
    // module as base64, which minifies to ~4.3 MB of JavaScript. That is the
    // single largest thing in the bundle by an order of magnitude, and the
    // limit is set just above it so the warning stays quiet while still
    // catching genuine regressions.
    //
    // The trade-off was taken deliberately in Step 1.1: the compat build needs
    // no bundler plugins and runs unchanged in Vite, in Node and in the Vitest
    // runner. Switching to `@dimforge/rapier3d` would emit the WASM as a
    // separate, stream-compilable, independently cacheable asset (~250 kB of
    // JS plus a 3 MB .wasm), at the cost of wasm-loader configuration and a
    // test-runner setup that no longer works out of the box.
    chunkSizeWarningLimit: 5000,
  },

  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
