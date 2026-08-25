/**
 * Smoke test against the REAL packaged bundle — the only test that proves
 * asar packing, `extraResources` binaries, ad-hoc signing and `app://` all
 * survived electron-builder.
 *
 * Requires `npm run dist` first. Skips (rather than fails) when the bundle is
 * absent so `npm run test:e2e` still works on a fresh checkout.
 *
 * The bundle lives outside the repo on purpose — see scripts/dist.mjs for why
 * (iCloud stamps com.apple.FinderInfo, which codesign refuses).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { makeFixtureDir, writePngFixture } from './fixtures';

const APP =
  process.env.WARP_PACKAGED_APP ??
  join(homedir(), 'Library/Caches/file-warper/release/mac-arm64/File Warper.app');

test.skip(!existsSync(APP), `packaged app not built (${APP}) — run \`npm run dist\``);

test('the packaged app converts a real PNG to WebP', async () => {
  test.setTimeout(120_000);
  const dir = await makeFixtureDir();
  const png = await writePngFixture(dir, 'shot.png');

  const app = await electron.launch({
    executablePath: join(APP, 'Contents/MacOS/File Warper'),
    env: { ...process.env, E2E: '1' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Proves we are driving the real bundle, not the dev tree.
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);

  await app.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    },
    [png],
  );

  await win.getByTestId('dropzone').click();
  await expect(win.getByTestId('file-row')).toHaveCount(1);
  await win.getByTestId('format-select').selectOption('webp');
  await win.getByTestId('convert-button').click();

  await expect(win.getByTestId('done-button')).toBeVisible({ timeout: 60_000 });
  await expect(win.getByTestId('status-text')).toContainText('1 file converted');

  // Default output location is alongside the input.
  const bytes = await readFile(png.replace(/\.png$/, '.webp'));
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');

  await app.close();
});
