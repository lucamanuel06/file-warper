import { defineConfig } from '@playwright/test';

/**
 * W2 owns e2e/harness/** (globalSetup, launch helpers, dialog stubs) — once
 * that lands, wire it in here (globalSetup, shared launch options, etc).
 * This is a minimal config so `npm run test:e2e` has somewhere to run
 * e2e/*.spec.ts today. Electron can't run headless on macOS, and multiple
 * instances sharing one temp output dir flake, so this stays single-worker.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
});
