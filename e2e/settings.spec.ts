/// <reference lib="dom" />
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
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

/**
 * Opens the sheet and waits past its `--dur-base` slide-down transition.
 * `toBeVisible()` only waits for the opening CSS state to apply, not for the
 * transition to finish interpolating — any test that reads geometry off the
 * sheet needs the settled position, not a mid-animation snapshot.
 */
async function openSettings(): Promise<Locator> {
  await win.getByTestId('settings-button').click();
  const sheet = win.getByTestId('settings-sheet');
  await expect(sheet).toBeVisible();
  await win.waitForTimeout(250);
  return sheet;
}

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

  await win.keyboard.press('Escape');
  await expect(win.getByTestId('settings-sheet')).toBeHidden();
});

test('the sheet leaves the backdrop reachable, and clicking it closes the sheet', async () => {
  const sheet = await openSettings();
  const backdrop = win.getByTestId('settings-backdrop');

  const sheetBox = await sheet.boundingBox();
  const backdropBox = await backdrop.boundingBox();
  if (!sheetBox || !backdropBox) {
    throw new Error('expected both the sheet and the backdrop to have a layout box');
  }

  // Pin: the sheet must never grow to fill the whole backdrop — that makes
  // "click outside to close" impossible everywhere on screen. Regression
  // coverage for exactly that defect.
  expect(sheetBox.height).toBeLessThan(backdropBox.height);

  // Click inside the guaranteed-visible strip below the sheet's bottom edge,
  // not an arbitrary corner that the sheet might cover.
  const gapTop = sheetBox.y + sheetBox.height;
  const gapBottom = backdropBox.y + backdropBox.height;
  await win.mouse.click(backdropBox.x + backdropBox.width / 2, (gapTop + gapBottom) / 2);

  await expect(sheet).toBeHidden();
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
