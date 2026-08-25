# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mixed-drop.spec.ts >> changing the target live re-evaluates which rows are dimmed
- Location: e2e/mixed-drop.spec.ts:53:5

# Error details

```
TimeoutError: locator.selectOption: Timeout 30000ms exceeded.
Call log:
  - waiting for getByTestId('format-select')
    - locator resolved to <select aria-label="Convert to" data-testid="format-select" class="FormatSelect-module__hPmIOW__select">…</select>
  - attempting select option action
    2 × waiting for element to be visible and enabled
      - did not find some options
    - retrying select option action
    - waiting 20ms
    2 × waiting for element to be visible and enabled
      - did not find some options
    - retrying select option action
      - waiting 100ms
    59 × waiting for element to be visible and enabled
       - did not find some options
     - retrying select option action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
  - generic [ref=f1e2]:
    - generic [ref=f1e3]: File Warper
    - main [ref=f1e5]:
      - region "Staged files" [ref=f1e6]:
        - generic [ref=f1e7]:
          - generic [ref=f1e8]: 3 files · 2 will convert
          - button "Clear" [ref=f1e9]
        - list [ref=f1e10]:
          - listitem [ref=f1e11]:
            - generic [ref=f1e12]: PNG
            - generic "a.png" [ref=f1e13]
            - generic [ref=f1e14]: 68 B
            - button "Remove a.png" [ref=f1e16]
          - listitem [ref=f1e19]:
            - generic [ref=f1e20]: PNG
            - generic "b.png" [ref=f1e21]
            - generic [ref=f1e22]: 68 B
            - button "Remove b.png" [ref=f1e24]
          - listitem [ref=f1e27]:
            - generic [ref=f1e28]: M4A
            - generic "c.mp4" [ref=f1e29]
            - generic [ref=f1e30]: Skipped
            - button "Remove c.mp4" [ref=f1e32]
    - generic [ref=f1e36]:
      - button "Options" [ref=f1e37]
      - generic [ref=f1e40]:
        - generic [ref=f1e41]:
          - generic [ref=f1e42]: Quality
          - radiogroup "Quality" [ref=f1e43]:
            - generic [ref=f1e44]:
              - radio "Smaller" [ref=f1e45]
              - generic [ref=f1e46]: Smaller
            - generic [ref=f1e47]:
              - radio "Balanced" [checked] [ref=f1e48]
              - generic [ref=f1e49]: Balanced
            - generic [ref=f1e50]:
              - radio "Best" [ref=f1e51]
              - generic [ref=f1e52]: Best
        - generic [ref=f1e53]:
          - generic [ref=f1e54]: Max size
          - combobox "Max size" [ref=f1e55]:
            - option "Original" [selected]
            - option "4000 px"
            - option "2000 px"
            - option "1000 px"
        - generic [ref=f1e56]:
          - generic [ref=f1e57]: Save to
          - button "Same folder as original" [ref=f1e58]
    - generic [ref=f1e59]:
      - generic [ref=f1e60]:
        - generic [ref=f1e61]: Convert to
        - combobox "Convert to" [ref=f1e63]:
          - option "TIFF"
          - option "Windows Icon"
          - option "Bitmap"
          - option "JPEG"
          - option "WebP" [selected]
          - option "GIF"
          - option "AVIF"
          - option "AAC"
          - option "WAV"
          - option "FLAC"
          - option "AIFF"
          - option "Core"
          - option "Sun AU"
          - option "Matroska"
          - option "MP3"
          - option "Ogg Vorbis"
          - option "Opus"
          - option "AC-3"
          - option "PDF"
          - option "Plain Text"
      - button "Convert 2" [ref=f1e65]
  - alert [ref=f1e66]
```

# Test source

```ts
  1  | /**
  2  |  * Requires the fully integrated app — see empty-state.spec.ts header.
  3  |  */
  4  | import {
  5  |   type ElectronApplication,
  6  |   _electron as electron,
  7  |   expect,
  8  |   type Page,
  9  |   test,
  10 | } from '@playwright/test';
  11 | import { makeFixtureDir, writeMp4Fixture, writePngFixture } from './fixtures';
  12 | 
  13 | let app: ElectronApplication;
  14 | let win: Page;
  15 | let paths: string[];
  16 | 
  17 | test.beforeAll(async () => {
  18 |   const dir = await makeFixtureDir();
  19 |   paths = [
  20 |     await writePngFixture(dir, 'a.png'),
  21 |     await writePngFixture(dir, 'b.png'),
  22 |     await writeMp4Fixture(dir, 'c.mp4'),
  23 |   ];
  24 |   app = await electron.launch({ args: ['.'], env: { ...process.env, E2E: '1' } });
  25 |   win = await app.firstWindow();
  26 |   await win.waitForLoadState('domcontentloaded');
  27 |   await app.evaluate(({ dialog }, ps) => {
  28 |     dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ps });
  29 |     dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  30 |     dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  31 |   }, paths);
  32 | });
  33 | 
  34 | test.afterAll(async () => {
  35 |   await app.close();
  36 | });
  37 | 
  38 | test('a mixed-category drop auto-switches to the majority category and dims the rest', async () => {
  39 |   await win.getByTestId('dropzone').click();
  40 |   await expect(win.getByTestId('file-row')).toHaveCount(3);
  41 | 
  42 |   // 2 of 3 files are images; the picker should auto-switch to the image default (WebP)
  43 |   // and the header should count only the reachable files as "will convert".
  44 |   await expect(win.getByTestId('list-header')).toContainText('2 will convert');
  45 |   await expect(win.getByTestId('format-select')).toHaveValue('webp');
  46 | 
  47 |   const rows = win.getByTestId('file-row');
  48 |   await expect(rows.nth(0)).not.toContainText('Skipped');
  49 |   await expect(rows.nth(1)).not.toContainText('Skipped');
  50 |   await expect(rows.nth(2)).toContainText('Skipped');
  51 | });
  52 | 
  53 | test('changing the target live re-evaluates which rows are dimmed', async () => {
> 54 |   await win.getByTestId('format-select').selectOption('mp4');
     |                                          ^ TimeoutError: locator.selectOption: Timeout 30000ms exceeded.
  55 |   const rows = win.getByTestId('file-row');
  56 |   await expect(rows.nth(0)).toContainText('Skipped');
  57 |   await expect(rows.nth(1)).toContainText('Skipped');
  58 |   await expect(rows.nth(2)).not.toContainText('Skipped');
  59 | });
  60 | 
```