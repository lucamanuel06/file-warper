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
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect, test } from '@playwright/test';
import { makeFixtureDir, writePngFixture } from './fixtures';

const run = promisify(execFile);
const ffmpeg = require('ffmpeg-static') as string;

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

test('the packaged app converts a real WAV to MP3', async () => {
  // The bundled-ffmpeg path, in the shipped artifact — this is the exact
  // conversion that failed in the field with "Unable to find a suitable output
  // format". Image conversions go through sharp and would not have caught it.
  test.setTimeout(120_000);
  const base = await makeFixtureDir();
  const dir = join(base, 'A muziek downloaden', 'Kermis 2026');
  await mkdir(dir, { recursive: true });
  const wav = join(dir, 'B2B Rens set.wav');
  await run(ffmpeg, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-ar',
    '44100',
    '-ac',
    '2',
    wav,
  ]);

  const app = await electron.launch({
    executablePath: join(APP, 'Contents/MacOS/File Warper'),
    env: { ...process.env, E2E: '1' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);

  await app.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    },
    [wav],
  );

  await win.getByTestId('dropzone').click();
  await expect(win.getByTestId('file-row')).toHaveCount(1);
  await win.getByTestId('format-select').selectOption('mp3');
  await win.getByTestId('convert-button').click();

  await expect(win.getByTestId('done-button')).toBeVisible({ timeout: 60_000 });
  await expect(win.getByTestId('status-text')).toContainText('1 file converted');

  const mp3 = await readFile(join(dir, 'B2B Rens set.mp3'));
  expect(mp3.length).toBeGreaterThan(1000);
  const isId3 = mp3.subarray(0, 3).toString('latin1') === 'ID3';
  const isFrame = mp3[0] === 0xff && ((mp3[1] ?? 0) & 0xe0) === 0xe0;
  expect(isId3 || isFrame, 'output is not an MP3').toBe(true);

  await app.close();
});
