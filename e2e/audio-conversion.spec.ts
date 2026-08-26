/**
 * REGRESSION: every A/V conversion failed in the shipped app with
 *   "Unable to find a suitable output format for '.filewarper-….tmp'"
 * because the scheduler stages the final hop under a name it chooses, and
 * ffmpeg picks its muxer from the output extension.
 *
 * Unit tests never caught it — they all wrote to `out.mp3`. Only the real
 * scheduler path produces the staging name, so this test drives the whole app.
 * The fixture directory deliberately contains spaces, matching real music
 * libraries (and catching any argv that is not passed as an array).
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect, test } from '@playwright/test';
import { makeFixtureDir } from './fixtures';

const run = promisify(execFile);
const ffmpeg = require('ffmpeg-static') as string;

test('converts a real WAV to MP3 through the app, on a path with spaces', async () => {
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

  const app = await electron.launch({ args: ['.'], env: { ...process.env, E2E: '1' } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
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

  const out = join(dir, 'B2B Rens set.mp3');
  const bytes = await readFile(out);
  expect(bytes.length).toBeGreaterThan(1000);
  const isId3 = bytes.subarray(0, 3).toString('latin1') === 'ID3';
  const isFrame = bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
  expect(isId3 || isFrame, 'output is not an MP3').toBe(true);

  // No staging file may survive a successful conversion.
  const { stdout } = await run('/bin/ls', ['-a', dir]);
  expect(stdout).not.toContain('.filewarper-');

  await app.close();
});
