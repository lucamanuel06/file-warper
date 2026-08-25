# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: empty-state.spec.ts >> opens exactly one window
- Location: e2e/empty-state.spec.ts:34:5

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 3
```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
  - generic [ref=f1e2]:
    - generic [ref=f1e3]: File Warper
    - main [ref=f1e5]:
      - button "Drop files here or click to browse" [ref=f1e6]:
        - generic [ref=f1e10]: Drop files here
        - generic [ref=f1e11]: or click to browse
  - alert [ref=f1e12]
```

# Test source

```ts
  1  | /**
  2  |  * Requires the fully integrated app (W2's main/preload/runtime built to
  3  |  * `dist/main/index.js`) — cannot run standalone in the w3-ui worktree.
  4  |  * Written against the harness pattern in docs/spec-ui.md §6; once W2's
  5  |  * e2e/harness/** lands, this should launch through its helpers instead of
  6  |  * calling `_electron.launch` and stubbing dialogs directly.
  7  |  */
  8  | import {
  9  |   type ElectronApplication,
  10 |   _electron as electron,
  11 |   expect,
  12 |   type Page,
  13 |   test,
  14 | } from '@playwright/test';
  15 | 
  16 | let app: ElectronApplication;
  17 | let win: Page;
  18 | 
  19 | test.beforeAll(async () => {
  20 |   app = await electron.launch({ args: ['.'], env: { ...process.env, E2E: '1' } });
  21 |   win = await app.firstWindow();
  22 |   await win.waitForLoadState('domcontentloaded');
  23 |   await app.evaluate(({ dialog }) => {
  24 |     dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  25 |     dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  26 |     dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  27 |   });
  28 | });
  29 | 
  30 | test.afterAll(async () => {
  31 |   await app.close();
  32 | });
  33 | 
  34 | test('opens exactly one window', async () => {
  35 |   expect(
  36 |     await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
> 37 |   ).toBe(1);
     |     ^ Error: expect(received).toBe(expected) // Object.is equality
  38 | });
  39 | 
  40 | test('renders the empty state with the footer and options row hidden', async () => {
  41 |   await expect(win.getByTestId('titlebar')).toBeVisible();
  42 |   await expect(win.getByTestId('dropzone')).toBeVisible();
  43 |   await expect(win.getByTestId('footer')).toBeHidden();
  44 |   await expect(win.getByTestId('options-disclosure')).toBeHidden();
  45 | });
  46 | 
```