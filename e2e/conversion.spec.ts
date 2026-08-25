/**
 * Requires the fully integrated app — see empty-state.spec.ts header. Also
 * requires W4's sharp-backed image converter to be merged and available.
 */
import { readFile } from 'node:fs/promises';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { makeFixtureDir, writePngFixture } from './fixtures';

let app: ElectronApplication;
let win: Page;
let fixturePath: string;

test.beforeAll(async () => {
  fixturePath = await writePngFixture(await makeFixtureDir(), 'sample.png');
  app = await electron.launch({ args: ['.'], env: { ...process.env, E2E: '1' } });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    },
    [fixturePath],
  );
});

test.afterAll(async () => {
  await app.close();
});

test('converts a real PNG to WebP, verified on magic bytes', async () => {
  test.setTimeout(60_000);

  await win.getByTestId('dropzone').click();
  await expect(win.getByTestId('format-select')).toHaveValue('webp');

  await win.getByTestId('convert-button').click();
  await expect(win.getByTestId('done-button')).toBeVisible({ timeout: 30_000 });
  await expect(win.getByTestId('status-text')).toContainText('1 file converted');

  const outputPath = fixturePath.replace(/\.png$/, '.webp');
  const bytes = await readFile(outputPath);
  // Magic bytes, never "file exists" — a bad arg string can produce a 0-byte file.
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
});
