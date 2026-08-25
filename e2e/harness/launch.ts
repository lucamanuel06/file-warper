/**
 * Shared launch helpers for both unpackaged (`args: ['.']`) and packaged
 * (`parseElectronApp('release')`) runs, plus the dialog-stub `beforeAll` that
 * every spec needs — an un-stubbed native dialog blocks main, and Playwright
 * times out uselessly waiting for a modal it can never see.
 */

import path from 'node:path';
import { type ElectronApplication, _electron as electron } from '@playwright/test';
import { parseElectronApp, stubMultipleDialogs } from 'electron-playwright-helpers';

const PROJECT_ROOT = path.join(__dirname, '..', '..');

export type LaunchMode = 'unpackaged' | 'packaged';

function e2eEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.E2E = '1';
  return env;
}

export async function launchApp(
  mode: LaunchMode = 'unpackaged',
): Promise<ElectronApplication> {
  const env = e2eEnv();

  if (mode === 'packaged') {
    const info = parseElectronApp(path.join(PROJECT_ROOT, 'release'));
    return electron.launch({
      executablePath: info.executable,
      args: [],
      env,
      cwd: PROJECT_ROOT,
    });
  }

  return electron.launch({ args: ['.'], env, cwd: PROJECT_ROOT });
}

/**
 * Unconditionally stubs the three dialogs that would otherwise block main.
 * Call this once per test, right after launch, before triggering anything
 * that might open a dialog.
 */
export async function stubDialogs(app: ElectronApplication): Promise<void> {
  await stubMultipleDialogs(app, [
    { method: 'showOpenDialog', value: { canceled: true, filePaths: [] } },
    { method: 'showSaveDialog', value: { canceled: true } },
    { method: 'showMessageBox', value: { response: 0, checkboxChecked: false } },
  ]);
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close();
}
