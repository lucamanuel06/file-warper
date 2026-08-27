# File Warper — UI/UX + Verification Spec

*Verified: electron `43.4.1` (pinned) · next `16.3.3` · react `19.2.8` · vitest `4.1.11` · @playwright/test `1.62.1` · @biomejs/biome `2.5.10` · electron-builder `26.15.3` · electron-playwright-helpers `3.1.2`*

> **Project deviations from the raw research** (resolved against the other three specs):
> - Electron is pinned to **43.4.1**, not 44 (see `spec-stack.md`).
> - TypeScript is pinned to **6.0.3**, not 7 — Next 16 needs the TS programmatic API that TS 7 does not ship.
> - The format picker shows **all reachable targets** grouped by `<optgroup>`, with a *Suggested* group of ~6 on top. Full capability, still one control. The research's "curate to 7 total" would break the product promise.
> - `sandbox: true` means the preload **cannot use `node:fs`**. The no-path-drop fallback (§4.3) must send bytes over IPC to main, not write files from preload.

---

## 0. Framing

The **option set is a function of the conversion backend**: sharp for images, a bundled static ffmpeg for A/V, the HTML hub + Chromium `printToPDF` for documents, and detect-don't-bundle LibreOffice for high-fidelity Office. That is what makes "3 options max" achievable — every other knob gets derived.

---

# PART A — UI/UX

## 1. The window

| | value |
|---|---|
| default | 560 x 640 |
| min | 460 x 520 |
| max | none (resizable, maximizable) |
| title bar strip | 52px, draggable |
| content padding | 20px |
| footer bar | 64px |

Persist bounds to `userData/window-state.json`; center on first launch. Never auto-grow the window as files are added — **the list scrolls, the window doesn't**.

### Three regions, always

```
+---------------------------------------------+
| . . .            File Warper                |  52px, -webkit-app-region: drag
+---------------------------------------------+
|                                             |
|              CONTENT AREA                   |  flex: 1, scrolls
|         (drop zone OR file list)            |
|                                             |
+---------------------------------------------+
| > Options                                   |  28px disclosure row
+---------------------------------------------+
|  Convert to [ WebP v ]         [ Convert ]  |  64px footer, hairline top
+---------------------------------------------+
```

Title text is 13px/600 `--text-secondary`, centered, always present — that is what native Mac apps do and it is how the user identifies the window in Mission Control. The footer and Options row are **hidden entirely in the empty state**; the app should look like one thing, not one thing plus disabled chrome.

### State A — Empty

The content area *is* the drop target. A single `<button>` (a real button — free focus, Enter/Space, VoiceOver) filling the area minus 20px, `border: 1.5px dashed var(--border-strong)`, `border-radius: var(--radius-lg)`.

Centered stack, 12px gaps:
- 32px inline SVG glyph (arrow descending into a tray), `--text-tertiary`
- `Drop files here` — 15px / 500 / `--text-primary`
- `or click to browse` — 13px / 400 / `--text-secondary`

**Drag-over:** border goes solid `--accent`, fill `--accent-subtle`, whole zone scales to `1.01` over 120ms. Nothing else moves. Revert on `dragleave`/`drop`. Clicking anywhere -> `dialog.showOpenDialog`.

### State B — Files staged

Drop zone collapses (160ms fade + 4px rise); list replaces it. Dropping more files while staged **appends**, never replaces — and the whole content area stays a drop target with a 1px `--accent` inset ring on drag-over.

**List header** (28px, sticky): `7 files · 4 will convert` left (13px, `--text-secondary`, tabular-nums), `Clear` text button right.

**Row** — 44px, `--radius-md` on hover (`--bg-hover`):

```
[PNG]  IMG_4021-final-export.png              2.4 MB   x
 ^         ^ 13px, middle-truncated            ^ 12px  ^ hover/focus only
 20px chip                                     tertiary
```

- **Chip:** 11px uppercase, `--font-mono`, `--bg-subtle`, `--radius-sm`, 4px x 6px padding. Shows the *source* extension while staged; **flips to the output extension when that file completes** — the single clearest "it worked" signal in the app.
- **Filename:** middle-truncate in JS. `text-overflow: ellipsis` truncates the wrong end — extensions are the informative part. Small `middleTruncate(name, 42)` util.
- Rows scroll after ~6; a 16px `mask-image` fade at both scroll edges rather than a visible scrollbar.

### Mixed-format drops — the actual rule

Group by **category** (image / audio / video / document / data / archive / font), never by extension. `jpg + png + heic -> WebP` is one homogeneous job and must feel like one.

When a drop spans categories: **no modal, no per-file targets, no silent discards.** Instead:

1. On drop, if **no** staged file matches the current target, auto-switch the target to the default for the *majority* category. This happens only on drop — never while the user is actively choosing a format.
2. Files that can't reach the current target stay in the list, dimmed to `opacity: 0.45`, with `Skipped` in 12px `--text-tertiary` where the size would be.
3. Header reads `7 files · 4 will convert`. Convert button reads `Convert 4`.

Changing the target **live re-evaluates** which rows are dim. That is the whole teaching mechanism: drag 7 mixed files, pick MP3, watch the images grey out, and understand the model without reading a word. Zero dialogs, fully reversible.

### The target format picker — a native `<select>`

`<select>` with `appearance: none`, custom chevron, styled to match. Free keyboard navigation, free type-ahead, free VoiceOver, free `<optgroup>`, correct native popover positioning — and it deletes ~150 lines of custom-popover code plus its focus-trap bugs.

**Native color invariant:** the popup is rendered by the OS, not by our CSS, so it only reads two things — `color-scheme` and inherited `color`/`background-color` on `option`/`optgroup`. `color-scheme` must track the *applied* theme (`:root[data-theme]`, see §3's variable block), not the OS preference alone, or Chromium picks the popup's light/dark rendering independently of the in-app toggle. `option`/`optgroup` additionally get explicit `color: var(--text-primary)` and `background-color: var(--bg-elevated)` under `.select` in both `FormatSelect.module.css` and `Controls.module.css` — inheritance into the native popup isn't reliable on Windows.

**Grouping (project decision):**
```
Suggested      <- ~6 entries: the same-category, lossless-first, most-popular targets
Image          <- every other reachable image target
Audio
Video
Document
Data
Archive
```
Only reachable targets are ever rendered (the router answers this — see `spec-core-architecture.md` §2). Remember the last target per category across launches.

Per-category defaults: Image -> **WebP** · Audio -> **MP3** · Video -> **MP4** · Document -> **PDF** · Data -> **JSON** · Archive -> **ZIP** · Font -> **WOFF2**.

### State C — Converting

- Format `<select>` and the Options disclosure disable via `opacity: 0.4; pointer-events: none`. Don't hide them — layout must not shift.
- Convert button -> `Cancel`, **secondary** styling (grey, not red — cancelling is not destructive).
- Footer status text, left of the button: `Converting 2 of 7…` with `aria-live="polite"`.
- **One** global indicator: a 2px bar pinned to the top edge of the footer, full width, `--accent`, width = overall percent. Not one bar plus seven bars competing for attention.
- **Per row:** a 2px `--accent` line along the row's bottom edge. Active row's filename is `--text-primary`; queued rows are `--text-secondary`. Completed rows swap `x` -> checkmark and flip the chip.
- **Concurrency is never exposed.** (The runtime picks it; see the core spec §4.)
- Progress source: ffmpeg's `-progress pipe:1` key/value stream against the probed duration. sharp jobs are effectively instant — jump them 0 -> 100.

### State D — Done

Do **not** auto-clear and do **not** auto-open Finder. Both are the classic mistakes; the user needs a beat to see what happened.

Footer: `7 files converted` (or `5 converted · 2 failed`) left; `Reveal in Finder` (secondary) and `Done` (primary -> resets to empty) right. Row hover reveals a small arrow button that reveals *that one file* via `shell.showItemInFolder(outPath)`.

Completion animation: rows check in with an 180ms fade + 2px rise, staggered 20ms. The app's one moment of personality. Gate on `prefers-reduced-motion`.

**Output naming:** alongside the input by default. `photo.png` -> `photo.webp`. On collision, `photo 2.webp` (Finder's own convention). **Never prompt.** This single rule deletes an entire class of modal dialogs.

### State E — Error

Errors are **per-file and inline. Never a modal.**

- Failed row: chip -> `--danger-subtle`, right side shows `Failed` in 12px `--danger`. The row becomes a `<button>` that expands a 2-line reason (the engine's last stderr line, truncated to 200 chars, 12px `--text-secondary`) plus a `Copy details` text button.
- Footer offers `Retry failed` (secondary) alongside `Done`.

Only **environment-level** failures get a banner — a 40px `--warn-subtle` strip at the top of the content area, 12px text, exactly one action:
1. Bundled ffmpeg missing or not executable (packaging bug) -> `Report issue`
2. Output folder not writable -> `Choose another folder…`
3. Office conversion requested, LibreOffice not installed -> `Learn more`

---

## 2. Options — one disclosure, three controls, contextual

A single left-aligned disclosure row above the footer: `> Options`, 12px, `--text-secondary`, 28px tall. Collapsed by default; expands 0 -> auto over 160ms; state persists per session. Each row inside is a 96px fixed-width label (12px, `--text-secondary`) with the control right-aligned.

**Control 3 is universal and always last:**

> **Save to** — a single button, two states: `Same folder as original` (default) / a chosen folder shown by basename with an `x` to revert. Click opens `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`.

**The other two are contextual to the target category:**

### Image
1. **Quality** — segmented: `Smaller` / **`Balanced`** / `Best` -> q 65 / 82 / 95. **Removed from the DOM entirely** for lossless targets (PNG, TIFF) — never render a disabled control.
2. **Max size** — select: **`Original`** / `4000 px` / `2000 px` / `1000 px`. Longest edge, never upscales.

*Derived, never exposed:* strip all EXIF except orientation; always honor orientation; always convert to sRGB; chroma subsampling 4:2:0 at Smaller/Balanced, 4:4:4 at Best.

### Audio
1. **Quality** — segmented: `Small` / **`Balanced`** / `Best` -> MP3 `V5/V2/V0`, AAC `96/160/256k`, Opus `64/128/192k`. Removed for WAV/FLAC.
2. **Channels** — select: **`Keep`** / `Mono`.

*Derived:* keep source sample rate, clamped to 48 kHz. Copy title/artist/album tags through.

### Video
1. **Quality** — segmented: `Smaller` / **`Balanced`** / `Best` -> CRF 28 / 23 / 18 (or codec-equivalent CQ).
2. **Resolution** — select: **`Original`** / `1080p` / `720p` / `480p`. Never upscales.

*Derived — hold the line on this one:* **codec is not a user choice.** MP4/MOV -> `libx264 -pix_fmt yuv420p -movflags +faststart` + AAC. WebM -> VP9 + Opus. GIF -> two-pass `palettegen`/`paletteuse`, 12 fps, 480px wide. A codec dropdown is precisely the option the brief forbids; if pressure ever mounts, the correct concession is a single checkbox `Use HEVC (smaller files)` — not a dropdown, and not in v1.

### Document
1. **Page size** — select: **`Auto`** / `A4` / `Letter`. **Only rendered when the target is PDF.**
2. *(nothing)*

Documents get one option, or zero. **An under-filled disclosure is correct, not a gap to fill.** Resist inventing a third control for symmetry.

### Data
1. **Flatten nested keys** — toggle, default **off**. Enables JSON -> CSV for nested input by joining paths with `.`.
2. *(nothing)*

Persist option values **per category** in `userData/prefs.json`.

---

## 3. Visual system

### Plain CSS + CSS Modules. No Tailwind.

Firm call, specific to this app:

1. **The design is token-driven, not utility-driven** — ~40 CSS custom properties, roughly eight components, one visual language. Tailwind's value is composing utilities across hundreds of varied components.
2. **Dark mode** needs `prefers-color-scheme` *plus* a manual override. Plain custom properties do this in 20 lines. Tailwind's `dark:` variant is class-driven and duplicates every color decision at every call site.
3. **Total CSS is ~500 lines.** Build-time content scanning has nothing to earn back at that size.
4. **Electron-specific selectors** — `-webkit-app-region`, `::-webkit-scrollbar`, `mask-image` fades, `:focus-visible` ring geometry — all land in arbitrary-value brackets anyway.

Structure: one `globals.css` (reset + tokens + `html`/`body`) plus a `.module.css` per component. No PostCSS plugins, no config file.

### Typography

13px is the macOS UI default and is the base. Scale: 11 (chips) / 12 (meta) / 13 (body) / 15 (drop-zone headline). Weights **400, 500, 600 only**. `font-synthesis: none`, `-webkit-font-smoothing: antialiased`, `font-variant-numeric: tabular-nums` on every size, count and percentage.

### The variable block

```css
:root {
  color-scheme: light;

  /* Type */
  --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text",
             "Helvetica Neue", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;

  --text-xs: 11px;      /* chips */
  --text-sm: 12px;      /* meta, labels */
  --text-base: 13px;    /* macOS default UI size */
  --text-lg: 15px;      /* drop-zone headline */

  --weight-normal: 400;
  --weight-medium: 500;
  --weight-semi: 600;

  /* Space (4pt grid) */
  --space-1: 4px;   --space-2: 8px;   --space-3: 12px;
  --space-4: 16px;  --space-5: 20px;  --space-6: 24px;
  --space-8: 32px;

  /* Radius */
  --radius-sm: 6px;     --radius-md: 8px;
  --radius-lg: 12px;    --radius-full: 999px;

  /* Motion */
  --ease: cubic-bezier(0.22, 0.61, 0.36, 1);
  --dur-fast: 120ms;    /* hover, press */
  --dur-base: 160ms;    /* disclosure, state swap */
  --dur-slow: 220ms;    /* completion stagger */

  /* Chrome */
  --titlebar-h: 52px;
  --footer-h: 64px;
  --row-h: 44px;
  --shadow-popover: 0 0 0 0.5px rgb(0 0 0 / 0.12),
                    0 8px 24px rgb(0 0 0 / 0.16);

  /* Color - LIGHT */
  --bg:          rgb(246 246 247 / 0.72);  /* alpha: sits on vibrancy */
  --bg-opaque:   #f6f6f7;                  /* fallback when vibrancy off */
  --bg-elevated: #ffffff;
  --bg-subtle:   rgb(0 0 0 / 0.045);
  --bg-hover:    rgb(0 0 0 / 0.055);
  --bg-active:   rgb(0 0 0 / 0.085);

  --text-primary:   rgb(0 0 0 / 0.88);
  --text-secondary: rgb(0 0 0 / 0.56);
  --text-tertiary:  rgb(0 0 0 / 0.36);
  --text-on-accent: #ffffff;

  --border:        rgb(0 0 0 / 0.10);
  --border-strong: rgb(0 0 0 / 0.18);

  --accent:        #007aff;   /* overwritten at runtime from the system accent */
  --accent-hover:  #0069d9;
  --accent-subtle: rgb(0 122 255 / 0.12);

  --danger:        #d70015;
  --danger-subtle: rgb(215 0 21 / 0.10);
  --warn-subtle:   rgb(255 159 10 / 0.16);
}

/* Color - DARK. Declared twice on purpose: once for the system preference
   (unless the user forced light) and once for an explicit in-app toggle. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg:          rgb(30 30 32 / 0.62);
    --bg-opaque:   #1e1e20;
    --bg-elevated: #2a2a2d;
    --bg-subtle:   rgb(255 255 255 / 0.06);
    --bg-hover:    rgb(255 255 255 / 0.075);
    --bg-active:   rgb(255 255 255 / 0.11);
    --text-primary:   rgb(255 255 255 / 0.92);
    --text-secondary: rgb(255 255 255 / 0.58);
    --text-tertiary:  rgb(255 255 255 / 0.36);
    --border:        rgb(255 255 255 / 0.11);
    --border-strong: rgb(255 255 255 / 0.20);
    --accent:        #0a84ff;
    --accent-hover:  #3d9bff;
    --accent-subtle: rgb(10 132 255 / 0.18);
    --danger:        #ff453a;
    --danger-subtle: rgb(255 69 58 / 0.16);
    --warn-subtle:   rgb(255 159 10 / 0.18);
    --shadow-popover: 0 0 0 0.5px rgb(255 255 255 / 0.10),
                      0 8px 24px rgb(0 0 0 / 0.44);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  /* rest of the block above, repeated so the manual toggle wins in both directions */
}
:root[data-theme="light"] {
  color-scheme: light;
  /* no other overrides — the light tokens are already :root's default */
}

html, body, #__next { height: 100%; margin: 0; }
body {
  background: var(--bg);       /* alpha over the vibrancy layer */
  color: var(--text-primary);
  font: var(--weight-normal) var(--text-base)/1.4 var(--font-ui);
  font-synthesis: none;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  user-select: none;           /* native app feel */
  cursor: default;
  overflow: hidden;
}

*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
@media (prefers-contrast: more) {
  :root {
    --border: rgb(0 0 0 / 0.28);
    --border-strong: rgb(0 0 0 / 0.45);
    --text-secondary: rgb(0 0 0 / 0.72);
  }
}
```

**One extra native touch, cheap and disproportionately effective** — read the user's actual macOS accent colour in main and inject it, so File Warper's blue matches their system blue:

```ts
const accent = systemPreferences.getAccentColor(); // "007affff" (RRGGBBAA)
win.webContents.insertCSS(`:root{--accent:#${accent.slice(0, 6)}}`);
```

### Motion budget
Hover/press 120ms · disclosure + state swap 160ms · completion stagger 220ms at 20ms intervals. All `var(--ease)`. Nothing else animates. **No spinners anywhere** — every wait in this app has a real percentage behind it, so every indicator is determinate.

---

## 4. Native feel

### 4.1 Window construction

```ts
const useVibrancy = true; // single kill switch

const win = new BrowserWindow({
  width: 560, height: 640,
  minWidth: 460, minHeight: 520,
  titleBarStyle: 'hiddenInset',
  trafficLightPosition: { x: 18, y: 18 }, // centres them in the 52px strip
  ...(useVibrancy
    ? { vibrancy: 'under-window',
        visualEffectState: 'followWindow',
        backgroundColor: '#00000000' }
    : { backgroundColor: '#f6f6f7' }),
  roundedCorners: true,
  show: false,                            // avoids the white flash
  webPreferences: {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  },
});
win.once('ready-to-show', () => win.show());
```

**Vibrancy gotchas, encode as rules:**
- Do **not** set `transparent: true`. `under-window` vibrancy does not need it, and the docs warn transparent windows "can sometimes leave behind visual artifacts on macOS."
- With vibrancy on you **must** set `backgroundColor: '#00000000'` and give `body` an *alpha* background — that is why `--bg` carries alpha and `--bg-opaque` exists as the fallback.
- Keep `visualEffectState: 'followWindow'` — the material dimming when the window loses focus is a real native cue users read subconsciously.
- Vibrancy follows the system appearance on its own; it needs no wiring to `prefers-color-scheme`.

### 4.2 Drag regions

```css
.titlebar { -webkit-app-region: drag; height: var(--titlebar-h); }
.titlebar button,
.titlebar input,
.titlebar select { -webkit-app-region: no-drag; }
```

- Every interactive descendant of a `drag` region needs explicit `no-drag`, including native `<select>` popovers.
- A `drag` region swallows clicks, `:hover`, and text selection. **Never make a scrollable container draggable.**
- Toggling an app-region element's visibility can leave a **stuck drag region**. Keep the title bar mounted at all times and change its contents, never its existence.
- Global `user-select: none` on `body` is the native default; opt individual text back in with `user-select: text` where it should be copyable (error details).

### 4.3 Dropped-file paths — CONFIRMED

`File.path` was Electron's own non-standard augmentation. **Electron 32 removed it** and replaced it with `webUtils.getPathForFile(file)`. From the current docs: *"This method superseded the previous augmentation to the `File` object with the `path` property."*

Signature: `webUtils.getPathForFile(file: File): string` — **renderer process only**, and with `contextIsolation: true` it must be called **in the preload** and exposed via `contextBridge`. It throws if passed a non-`File`, and returns `''` for a `File` constructed in JS with no disk backing.

```ts
// preload.ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('warp', {
  // The ONLY correct way to resolve a dropped file to an absolute path.
  pathsForFiles: (files: File[]): string[] =>
    files.map((f) => webUtils.getPathForFile(f)),
  // ... invoke/on wrappers, see spec-stack.md §5
});
```

```ts
// renderer
function onDrop(e: React.DragEvent) {
  e.preventDefault();
  // MUST be synchronous — DataTransfer is neutered after any await.
  const files = Array.from(e.dataTransfer.files);
  const paths = window.warp.pathsForFiles(files).filter(Boolean);
  void stage(paths);
}
```

**Three failure modes, all real and all reported upstream:**

1. **Chromium navigates away from the app** if `dragover` and `drop` aren't both prevented. Guard globally, not just on the zone:
   ```ts
   for (const ev of ['dragover', 'drop'] as const)
     window.addEventListener(ev, (e) => e.preventDefault());
   ```
   Belt and braces in main: `win.webContents.on('will-navigate', (e) => e.preventDefault())` and a `setWindowOpenHandler` returning `{ action: 'deny' }`.

2. **Reading `dataTransfer.files` after an `await`** yields an empty list. Read synchronously, resolve paths synchronously, *then* go async.

3. **`getPathForFile` legitimately returns `''`** for drags carrying no on-disk file — Mail attachments, Photos.app, not-yet-downloaded iCloud files, anything synthesized in JS. Electron issues [#44370](https://github.com/electron/electron/issues/44370) and [#44600](https://github.com/electron/electron/issues/44600) are both **closed** and largely trace to this class of source rather than a regression.
   **PROJECT DEVIATION — the fallback must not use `fs` in preload.** Under `sandbox: true` the preload has no Node builtins. Send the bytes to main instead:
   ```ts
   // preload
   spillToTemp: async (file: File): Promise<string> =>
     ipcRenderer.invoke('temp:spill', file.name, await file.arrayBuffer()),
   // main writes it into the session temp dir and returns the absolute path
   ```
   Renderer: if `pathsForFiles` returns `''` at index *i*, spill `files[i]` and use that path. Clean the temp dir on `will-quit`.

**Note:** `dialog.showOpenDialog` returns real absolute paths directly — the browse path never needs `webUtils` at all.

**Bonus, ~10 lines:** dropping a *folder* also yields a `File`, and `getPathForFile` returns the directory path. `stat` it in main and expand one level (non-recursive). Users expect this.

### 4.4 Native dialogs & Finder

```ts
ipcMain.handle('dialog:openFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    // No `filters` — this app converts ANY file type. A filter here is a lie.
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.on('shell:reveal', (_e, p: string) => shell.showItemInFolder(p));
```

Pass `win` as the parent so dialogs render as **sheets** attached to the window — a large, nearly free native-feel win.

**Also required on macOS:**
- **Build an app menu.** Without an explicit `Menu.setApplicationMenu`, Cmd+C/V/X/A/Q/W simply don't work. Minimal template: App (About / Settings ⌘, / Hide / Quit), File (Open… ⌘O, Close ⌘W), Edit (standard roles), Window, Help.
- **`app.on('open-file')`** for Finder "Open With" and Dock drops. Requires `CFBundleDocumentTypes` with `LSItemContentTypes: ["public.item"]` in the plist. It fires **before `app.whenReady()`** — buffer the paths and flush after the window exists.
- `app.setAboutPanelOptions({ applicationName, applicationVersion, credits })`.
- `app.on('window-all-closed')` -> do **not** quit on macOS.

### 4.5 Serving the renderer
`app://local/` via `protocol.handle` — see `spec-stack.md` §4 for the full handler, CSP, and the reasons `file://` is rejected.

---

## 5. Accessibility & keyboard

**Semantics (free wins, take all of them):**
- Drop zone = `<button>` -> free focus, Enter, Space, VoiceOver.
- Format picker = `<select>` + `<optgroup>` -> free type-ahead, arrow keys, native popover.
- File list = `<ul role="list">` / `<li>`; remove buttons carry `aria-label="Remove IMG_4021.png"`.
- Footer status has `aria-live="polite"` — announces "Converting 2 of 7", "7 files converted", "2 failed".
- Progress bars: `role="progressbar"` with `aria-valuenow` / `aria-valuemin=0` / `aria-valuemax=100`.
- Options disclosure: `<button aria-expanded>` controlling a region by `aria-controls`.

| Key | Action | Wired via |
|---|---|---|
| ⌘O | Open file dialog | **App menu accelerator** — works regardless of focus |
| Enter | Convert | default button + `autofocus` when files stage — native, free |
| Esc | Close `<select>` -> collapse Options -> **cancel conversion**. No-op otherwise. | keydown, in that priority order |
| ⌘⌫ | Clear the list | menu accelerator |
| ⌘R | Reveal in Finder (done state only) | menu accelerator |
| Tab | zone -> list rows -> Options -> format -> Convert | DOM order; no `tabindex` above 0 |
| ⌘W / ⌘Q / ⌘, | Standard | menu roles |

**Deliberately: Esc does not clear a staged list.** Destructive-on-Esc is a trap. ⌘⌫ is the Mac idiom for delete.

**Focus rings:** `:focus-visible` only, 2px `--accent` at 2px offset. Never `outline: none` without a replacement — enforce it in Biome as an error, not a code-review convention.

---

# PART B — Testing & verification

## 6. The stack

### Vitest 4.1 — the conversion core

The high-value target isn't components; it's **argument construction**. Keep the core pure and I/O-free, then **snapshot-test the arg arrays** — that is where the bugs live and where regressions are otherwise invisible. Table-driven tests for mixed-drop skip logic and collision naming (`photo.webp` -> `photo 2.webp` -> `photo 3.webp`) are worth more than any component test in this app.

```ts
// vitest.config.ts — note the Vitest 4 shape
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    maxWorkers: 4,          // v4: replaced maxThreads / maxForks
    coverage: {
      provider: 'v8',       // v4: rewritten, AST-aware remapping
      include: ['src/core/**', 'src/converters/**'],
      thresholds: { lines: 80, functions: 80 },
    },
  },
});
```

**Vitest 4 breaking changes you'll hit if you copy an older config:** `poolOptions` is gone (options moved to the top level); `maxThreads`/`maxForks` collapsed into `maxWorkers`; `coverage.all` and `coverage.ignoreEmptyLines` removed; `browser` is now an object, not a string.

Skip component unit tests entirely — eight thin components; E2E covers them at lower total cost.

### Playwright 1.62 `_electron.launch` — CONFIRMED current

Still the right answer and still officially documented by Electron. Marked "experimental," but it is what VS Code uses in CI, and the surface has not changed.

```ts
import { test, expect, _electron as electron } from '@playwright/test';

let app; let win;
test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, E2E: '1' } });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});
test.afterAll(async () => { await app.close(); });

test('opens one window in the empty state', async () => {
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await expect(win.getByTestId('dropzone')).toBeVisible();
  await expect(win.getByTestId('footer')).toBeHidden();   // hidden when empty
});
```

### The E2E pitfalls list — read before writing a single spec

1. **You cannot simulate a native OS file drop.** Playwright's `dragTo`/CDP drag events do not produce a real `DataTransfer` carrying filesystem-backed `File` objects. Don't try. Two clean routes:
   - **(a) Stub the dialog in main** — tests the *real* production code path, and is the primary technique:
     ```ts
     await app.evaluate(({ dialog }, paths) => {
       // @ts-expect-error test stub
       dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
     }, [fixturePng]);
     await win.getByTestId('dropzone').click();
     ```
   - **(b) A test-only escape hatch** gated on `process.env.E2E`, exposed from preload as `window.__test.stagePaths(paths)`, for the drop-specific branches. Keep it to one function.
2. **Any un-stubbed native dialog blocks the main process** and Playwright times out with a useless error. Stub `showOpenDialog`, `showSaveDialog` and `showMessageBox` in `beforeAll` unconditionally.
3. **Build before you test.** Add a `globalSetup` that runs `next build` when `out/index.html` is missing or stale.
4. **Main must know it's under test.** Gate the renderer URL on `app.isPackaged || process.env.E2E` so it loads `app://local/` rather than `localhost:3000`.
5. **`app.close()` hangs if child processes are alive.** Kill every ffmpeg child on `before-quit`, or every failing test costs 30 seconds.
6. **`firstWindow()` can resolve before the renderer is interactive** with `show: false` + `ready-to-show`. Always follow with `waitForLoadState('domcontentloaded')` and assert on a `data-testid`, never a bare timeout.
7. **Serialize.** `workers: 1`, `fullyParallel: false`. Multiple Electron instances sharing one temp output directory produce flakes that look like real bugs.
8. **Don't set `webServer` or `use.baseURL`** — web-only config that will confuse the runner.
9. **Never hand-roll a CDP connection** and don't pin an old Playwright: Electron 30+ rejects `--remote-debugging-port` at the CLI, which Playwright [fixed](https://github.com/microsoft/playwright/issues/39008) internally.
10. Under E2E, `app.dock?.hide()` stops macOS stealing focus every run.

### Next static export + Playwright, specifically
- The `file://` asset-path problem is **designed out** by the `app://` scheme — no `assetPrefix`, and `page.url()` becomes a stable, assertable string.
- `output: 'export'` **requires** `images.unoptimized: true`. Simpler still: use inline SVG and skip `next/image` entirely — there are three glyphs in this app.
- Next's dev overlay and Fast Refresh sockets don't exist in an export build, so no hydration-timing flake. Assert on `data-testid`, never on generated class names.

---

## 7. Verifying a real, built `.app`

### The headless question, answered

**Electron cannot run headless on macOS.** There is no Xvfb equivalent — it needs a real WindowServer session.
- **Locally:** just run it. `app.dock?.hide()` under `E2E=1` reduces the focus-stealing nuisance.
- **In CI:** GitHub Actions `macos-latest` runners **do** have a WindowServer, so GUI Electron tests run there with no extra setup.
- **What does not work:** SSH-only sessions, `launchd` daemons, Docker.

### Launching the packaged bundle

```ts
import { parseElectronApp } from 'electron-playwright-helpers'; // 3.1.2
const info = parseElectronApp('release');   // handles mac-arm64 vs mac vs mac-universal
const app = await electron.launch({
  executablePath: info.executable,
  args: [info.main],
  env: { ...process.env, E2E: '1' },
});
// The one assertion that proves you're testing the real bundle:
expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
```

### Pre-flight shell checks — the failures Playwright can't see

Wire into `npm run verify:app`:

```bash
APP="release/mac-arm64/File Warper.app"

# 1. Signature valid and bundle intact
codesign --verify --deep --strict --verbose=2 "$APP"
# 2. Gatekeeper would actually let a user open it
spctl -a -t exec -vvv "$APP"
# 3. Plist sanity: doc types (for Open With), min OS, version
plutil -p "$APP/Contents/Info.plist" | grep -E 'CFBundleDocumentTypes|LSMinimumSystemVersion|CFBundleShortVersionString'
# 4. THE big one: the bundled ffmpeg survived packaging AND signing
FF="$APP/Contents/Resources/bin/ffmpeg"
test -x "$FF" && "$FF" -version | head -1
codesign --verify --verbose=2 "$FF"
```

**Check 4 is the single most common breakage in this class of app.** Three rules prevent it:
- Static ffmpeg binaries go in **`extraResources`**, never inside the asar — asar-packed binaries cannot be `exec`'d.
- Resolve as `process.resourcesPath` when `app.isPackaged`, from `node_modules` otherwise. One helper, used everywhere.
- **sharp** additionally needs `asarUnpack: ["**/node_modules/sharp/**", "**/node_modules/@img/**"]`.

Assert the same from inside the app so it is covered on every E2E run:

```ts
test('bundled ffmpeg is present and executable', async () => {
  const r = await app.evaluate(async () => {
    const { spawnSync } = require('node:child_process');
    const p = require('./ffmpeg-path').ffmpegPath;
    const out = spawnSync(p, ['-version']);
    return { status: out.status, first: String(out.stdout).split('\n')[0] };
  });
  expect(r.status).toBe(0);
  expect(r.first).toContain('ffmpeg version');
});
```

### The real end-to-end conversion smoke test

Fixtures generated at test time, all tiny, covering all three backends:

| Fixture | Convert to | Assertion |
|---|---|---|
| `sample.png` (32x32) | WebP | bytes `0..3 === 'RIFF'` && `8..11 === 'WEBP'` |
| `sample.wav` (0.5 s silence) | MP3 | starts with `ID3` or `0xFF 0xFB` |
| `sample.mp4` (1 s, 32x32) | GIF | starts with `GIF89a` |
| `sample.md` | PDF | starts `%PDF-`, ends `%%EOF` |

**Magic-byte assertions, never "file exists"** — ffmpeg happily writes a 0-byte or malformed file on a bad arg string, and existence checks sail right past the exact bug you're trying to catch. `test.setTimeout(60_000)` for the video case.

---

## 8. Lint & format — Biome 2.5. Firm.

One dependency, one config file, replacing ESLint + Prettier + `typescript-eslint` + `eslint-plugin-react-hooks` + `eslint-config-prettier` + `eslint-plugin-import` and their peer-dependency matrix. Roughly 10-50x faster, which matters most in a pre-commit hook.

The two objections that used to hold and no longer do:
- **Type-aware rules:** Biome v2 ships type-aware JS/TS linting that doesn't shell out to `tsc` — `noFloatingPromises` and friends work without the compiler in the loop.
- **React hooks:** covered by `correctness/useExhaustiveDependencies` and `correctness/useHookAtTopLevel`.

Biome also formats and lints CSS and JSON, so `.module.css` files are covered by the same tool and command.

**Biome is not a type checker** — keep `tsc --noEmit` as a separate step.

**Do not turn off `a11y` rules to make the build pass.** In an app this small that rule set is most of the accessibility guarantee, and §5's requirements are exactly what it enforces.

---

## Two things to push back on later

1. **"Add a codec dropdown."** Handle it with the derived-codec table in §2 and, at most, a single HEVC checkbox.
2. **"Auto-open Finder when done."** No. Keep the done state visible with `Reveal in Finder` as a button. Auto-opening steals focus and destroys the calm the whole design is built around.

---

**Sources:** [Electron `webUtils`](https://www.electronjs.org/docs/latest/api/web-utils) · [BaseWindow options](https://github.com/electron/electron/blob/main/docs/api/structures/base-window-options.md) · [Electron `protocol.handle`](https://www.electronjs.org/docs/latest/api/protocol) · [Electron Automated Testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing) · [Playwright Electron API](https://playwright.dev/docs/api/class-electron) · [playwright#39008](https://github.com/microsoft/playwright/issues/39008) · [electron#44370](https://github.com/electron/electron/issues/44370) · [electron-playwright-helpers](https://github.com/spaceagetv/electron-playwright-helpers) · [Vitest 4.0](https://vitest.dev/blog/vitest-4) · [Biome v2](https://biomejs.dev/blog/biome-v2/)
