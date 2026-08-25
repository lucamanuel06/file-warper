import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  globalSetup: path.join(__dirname, 'e2e/harness/global-setup.ts'),
  // Electron cannot run headless on macOS, and multiple instances sharing one
  // session temp dir flake in ways that look like real bugs — one worker, in order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  // Generous: the video fixtures genuinely take a few seconds each.
  timeout: 60_000,
});
