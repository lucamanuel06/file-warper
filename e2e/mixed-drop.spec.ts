/**
 * Requires the fully integrated app — see empty-state.spec.ts header.
 */
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { makeFixtureDir, writeMp4Fixture, writePngFixture } from './fixtures';

let app: ElectronApplication;
let win: Page;
let paths: string[];

test.beforeAll(async () => {
  const dir = await makeFixtureDir();
  paths = [
    await writePngFixture(dir, 'a.png'),
    await writePngFixture(dir, 'b.png'),
    await writeMp4Fixture(dir, 'c.mp4'),
  ];
  app = await electron.launch({ args: ['.'], env: { ...process.env, E2E: '1' } });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ dialog }, ps) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ps });
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, paths);
});

test.afterAll(async () => {
  await app.close();
});

test('a mixed-category drop auto-switches to the majority category and dims the rest', async () => {
  await win.getByTestId('dropzone').click();
  await expect(win.getByTestId('file-row')).toHaveCount(3);

  // 2 of 3 files are images; the picker should auto-switch to the image default (WebP)
  // and the header should count only the reachable files as "will convert".
  await expect(win.getByTestId('list-header')).toContainText('2 will convert');
  await expect(win.getByTestId('format-select')).toHaveValue('webp');

  const rows = win.getByTestId('file-row');
  await expect(rows.nth(0)).not.toContainText('Skipped');
  await expect(rows.nth(1)).not.toContainText('Skipped');
  await expect(rows.nth(2)).toContainText('Skipped');
});

test('changing the target live re-evaluates which rows are dimmed', async () => {
  await win.getByTestId('format-select').selectOption('mp4');
  const rows = win.getByTestId('file-row');
  await expect(rows.nth(0)).toContainText('Skipped');
  await expect(rows.nth(1)).toContainText('Skipped');
  await expect(rows.nth(2)).not.toContainText('Skipped');
});
