import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  globalSetup: path.join(__dirname, 'e2e/harness/global-setup.ts'),
  // Electron windows and the shared session temp dir don't like concurrent
  // instances stepping on each other — one worker, in order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
});
