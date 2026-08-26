/**
 * Requires the fully integrated app (the main-process `settings:get` /
 * `settings:set` / `update:check` / `update:open` handlers) — cannot run
 * standalone in this worktree. Written against the harness pattern in
 * docs/spec-ui.md §6; once the main-process agent's IPC handlers land, this
 * should launch through `e2e/harness/launch.ts` like the other specs.
 */
/// <reference lib="dom" />
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, E2E: '1' } });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
});

test.afterAll(async () => {
  await app.close();
});

test('the gear button opens the settings sheet, Esc closes it', async () => {
  await expect(win.getByTestId('settings-sheet')).toBeHidden();
  await win.getByTestId('settings-button').click();
  await expect(win.getByTestId('settings-sheet')).toBeVisible();

  await win.keyboard.press('Escape');
  await expect(win.getByTestId('settings-sheet')).toBeHidden();
  await expect(win.getByTestId('settings-button')).toBeFocused();
});

test('Cmd+, opens the settings sheet via the warp:menu-settings event', async () => {
  await win.evaluate(() => {
    window.dispatchEvent(new CustomEvent('warp:menu-settings'));
  });
  await expect(win.getByTestId('settings-sheet')).toBeVisible();

  await win.getByTestId('settings-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(win.getByTestId('settings-sheet')).toBeHidden();
});

test('toggling a setting writes through settings:set and persists across reload', async () => {
  await win.getByTestId('settings-button').click();
  await expect(win.getByTestId('settings-sheet')).toBeVisible();

  const toggle = win.getByTestId('reveal-when-done-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await expect
    .poll(() => win.evaluate(() => window.warp.invoke('settings:get')))
    .toMatchObject({ revealWhenDone: true });

  await win.reload();
  await win.waitForLoadState('domcontentloaded');

  await expect
    .poll(() => win.evaluate(() => window.warp.invoke('settings:get')))
    .toMatchObject({ revealWhenDone: true });
});

test('the theme segmented control flips data-theme on <html>', async () => {
  await win.getByTestId('settings-button').click();
  await expect(win.getByTestId('settings-sheet')).toBeVisible();

  const themeControl = win.getByTestId('theme-control');
  await themeControl.getByText('Dark', { exact: true }).click();
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');

  await themeControl.getByText('Light', { exact: true }).click();
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');

  await themeControl.getByText('System', { exact: true }).click();
  await expect(win.locator('html')).not.toHaveAttribute('data-theme');
});
