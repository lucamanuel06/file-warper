/**
 * Requires the fully integrated app (W2's main/preload/runtime built to
 * `dist/main/index.js`) — cannot run standalone in the w3-ui worktree.
 * Written against the harness pattern in docs/spec-ui.md §6; once W2's
 * e2e/harness/** lands, this should launch through its helpers instead of
 * calling `_electron.launch` and stubbing dialogs directly.
 */
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

test('opens exactly one window', async () => {
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1);
});

test('renders the empty state with the footer and options row hidden', async () => {
  await expect(win.getByTestId('titlebar')).toBeVisible();
  await expect(win.getByTestId('dropzone')).toBeVisible();
  await expect(win.getByTestId('footer')).toBeHidden();
  await expect(win.getByTestId('options-disclosure')).toBeHidden();
});

test('exposes the host platform on <html>, whichever platform that is', async () => {
  // Asserted against the ACTUAL host, not a hardcoded 'darwin'. The original
  // version pinned darwin and therefore failed the moment CI started running
  // this suite on ubuntu — the test was wrong, not the app.
  const hostPlatform = await app.evaluate(() => process.platform);

  // Set async, off the `dom-ready` event — wait rather than race it.
  await win.waitForFunction(() => document.documentElement.hasAttribute('data-platform'));
  const platform = await win.evaluate(() =>
    document.documentElement.getAttribute('data-platform'),
  );
  expect(platform).toBe(hostPlatform);

  // The settings entry point must exist on every platform. On Windows the
  // gear has to clear the window-controls overlay; on Linux the desktop draws
  // the frame — either way the button is present and usable.
  await expect(win.getByTestId('settings-button')).toBeVisible();
  await expect(win.getByTestId('settings-button')).toBeEnabled();
});
