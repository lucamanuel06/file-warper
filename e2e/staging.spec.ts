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

test('clicking the dropzone stages a file via the stubbed native dialog', async () => {
  await win.getByTestId('dropzone').click();

  await expect(win.getByTestId('list-header')).toBeVisible();
  await expect(win.getByTestId('footer')).toBeVisible();

  const rows = win.getByTestId('file-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('sample.png');
  await expect(rows.first()).toContainText('PNG');
});

test('the remove button has an accessible label', async () => {
  await expect(win.getByRole('button', { name: 'Remove sample.png' })).toBeAttached();
});
