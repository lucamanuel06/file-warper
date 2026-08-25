# File Warper — Build Plan

**Goal:** a macOS desktop app that converts essentially any file into another type, fully offline, with a minimal calm UI and very few options.

**Stack (settled, do not re-litigate):** Electron 43.4.1 + TypeScript 6.0.3 (main/preload compiled to CJS by esbuild) + Next.js 16.3.3 static export served over a custom `app://` scheme. Plain CSS + CSS Modules. Vitest 4 + Playwright 1.62. Biome 2.5. Packaged unsigned-but-ad-hoc-signed with electron-builder 26.

Read these first — they are the specs, not suggestions:

| Doc | What it settles |
|---|---|
| `docs/spec-stack.md` | Electron+Next wiring, `app://` handler, IPC typing, esbuild, packaging, macOS landmines |
| `docs/spec-core-architecture.md` | Converter contract, format graph + layered Dijkstra, job execution, temp/output policy, test strategy |
| `docs/spec-engines.md` | Which library for which format, the trap list, licensing, realistic coverage |
| `docs/spec-ui.md` | Every UI state, the design tokens, native-feel details, E2E pitfalls |

---

## 1. Repository shape

Single npm package — **not** a monorepo. Workspaces plus electron-builder plus a Next static export is a known pain, and directory boundaries plus path aliases give us the same discipline for none of the cost.

```
src/
  core/          @warp/core — PURE TS, ZERO runtime deps, no electron, no native.
                 Bundled into the renderer, so keep it clean.
    types.ts       FROZEN  contracts
    formats.ts     FROZEN  the ~94-format registry
    registry.ts    W1: ConverterRegistry
    graph.ts       W1: FormatGraph + layered Dijkstra router
    detect.ts      W1: magic -> extension -> content sniff
    naming.ts      W1: output paths, collisions, sanitisation
  shared/        types + constants shared with the renderer
    ipc.ts         FROZEN  IPC contract
  converters/    the engines. Import core TYPES only. Never imported by the renderer.
    image/       W4
    av/          W4
    document/    W5
    data/        W5
    archive/     W5
    font/        W5
    subtitle/    W5
    index.ts     W1 owns the barrel; each workstream appends its own registration
  runtime/       W2 — scheduler, utilityProcess pool, temp manager, job queue
  main/          W2 — electron main, protocol, window, menu, printToPDF host
  preload/       W2 — contextBridge
  app/           W3 — Next.js App Router (single route)
  ui/            W3 — components + design system
scripts/         build-electron.mjs (done), vendor-binaries.mjs (W2), verify-app.sh (W2)
e2e/             W3 owns the specs, W2 owns the harness
test/            shared fixture generators (W1)
docs/            the four specs + this plan
```

**Path aliases** (already configured in both tsconfigs): `@core/*`, `@shared/*`, `@converters/*`, `@runtime/*`, `@ui/*`.

---

## 2. The five workstreams

Each runs in its own git worktree on its own branch, off `main` at the foundation commit. **Ownership is strict: only touch files under your own paths.** If you need something outside them, define it behind an interface that already exists in `src/core/types.ts` or `src/shared/ipc.ts` and say so in your final report.

| # | Branch | Owns | Deliverable |
|---|---|---|---|
| **W1** | `w1-core` | `src/core/**` (except the two frozen files), `test/**` | Registry, format graph + router, detection, output naming, the full unit-test layer |
| **W2** | `w2-runtime` | `src/runtime/**`, `src/main/**`, `src/preload/**`, `scripts/vendor-binaries.mjs`, `scripts/verify-app.sh`, `electron-builder.yml`, `e2e/harness/**` | Electron shell, `app://`, scheduler + utilityProcess pool, temp manager, printToPDF host, packaging |
| **W3** | `w3-ui` | `src/app/**`, `src/ui/**`, `e2e/*.spec.ts` | The complete renderer: all five states, design tokens, options disclosure, E2E specs |
| **W4** | `w4-media` | `src/converters/image/**`, `src/converters/av/**` | sharp + heic + psd + ico + svg; ffmpeg/ffprobe adapters, remux fast path, progress parsing |
| **W5** | `w5-docs` | `src/converters/document/**`, `data/**`, `archive/**`, `font/**`, `subtitle/**` | The HTML hub, docx/odf/pdf/spreadsheets, all data formats, archives, fonts, subtitles |

### Why this split
W1 is the foundation everyone depends on — but its *interfaces* are already frozen in `types.ts`, so the other four can start immediately against them rather than waiting. W2 and W3 meet only at `src/shared/ipc.ts`, which is frozen. W4 and W5 never touch each other and both only produce `Converter` objects.

---

## 3. The integration contract

This is the whole reason the five can run in parallel.

**Every converter is a `Converter` object** (`src/core/types.ts`) exported from a module under its own directory, plus a default-exported array from that directory's `index.ts`:

```ts
// src/converters/image/index.ts
import type { Converter } from '@core/types';
import { sharpRaster } from './sharp-raster';
import { heicDecode } from './heic';
export const imageConverters: Converter[] = [sharpRaster, heicDecode /* … */];
```

W1 owns `src/converters/index.ts`, which is only ever this:

```ts
export const ALL_CONVERTERS: Converter[] = [
  ...imageConverters, ...avConverters, ...documentConverters,
  ...dataConverters, ...archiveConverters, ...fontConverters, ...subtitleConverters,
];
```

Each of W4/W5 creates its own `index.ts` exporting the named array. **W1 writes the barrel referencing all seven arrays up front**, so integration is a no-op merge.

**Rules that make this work:**
1. A converter never imports from another converter directory.
2. A converter never imports `electron`. If it needs `printToPDF` or an offscreen canvas, it sets `residency: 'main'` and W2's `MainHopRunner` executes it — the converter still just receives `(input, output, options, ctx)`.
3. `availability()` never throws and is cheap. Missing binary = `{ available: false, reason, remedy }`.
4. Every `FormatId` you declare must exist in `src/core/formats.ts`. If a format you need is missing, **say so in your report** — do not edit the frozen file.
5. Route through the hubs (`png`, `wav`, `html`, `pdf`, `txt`, `json`, `zip`) rather than declaring N^2 direct edges. `docx -> pdf` is `docx -> html -> pdf` and that is by design.

---

## 4. Build order and dependencies

Nothing blocks: everyone codes against the frozen contracts from minute one.

```
W1 core ────────────────────────────────────────► merge 1st (everything imports it)
W2 runtime + shell ─────────────────────────────► merge 2nd (needs core's router)
W4 media converters ────────────────────────────► merge 3rd
W5 doc/data/archive converters ─────────────────► merge 4th
W3 ui ──────────────────────────────────────────► merge 5th (needs the IPC surface live)
```

Merge order is about conflict minimisation, not readiness — all five run concurrently.

---

## 5. Definition of done — per workstream

Every workstream must, before reporting complete:

1. `npx tsc -p tsconfig.node.json --noEmit` passes for the files you own (W3: `tsconfig.json`).
2. `npx biome check src/<your dirs>` passes. **Do not disable a11y rules to get green.**
3. `npx vitest run src/<your dirs>` passes, with real tests — not placeholders.
4. Your final report lists: what works, what you deliberately left out, any contract change you had to make, and anything you need from another workstream.

**Do not** run `npm install` (the tree is already installed and shared), edit `package.json`, or touch another workstream's files.

---

## 6. Definition of done — the app

The integrator (main session) verifies all of this after merging:

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm test` green
- [ ] `npm run build` produces `out/index.html` and `dist/main/index.js`
- [ ] `npm run dev` opens a window that renders the UI
- [ ] `npm run dist` produces `release/mac-arm64/File Warper.app`
- [ ] `npm run verify:app` passes — signature, Gatekeeper, plist, **and the bundled ffmpeg is executable**
- [ ] `npm run test:e2e` green against the packaged app
- [ ] A real end-to-end conversion in each engine, asserted on magic bytes:
      png -> webp (sharp) · wav -> mp3 (ffmpeg) · mp4 -> gif (ffmpeg) · md -> pdf (chromium) · json -> yaml (pure JS) · zip -> tar (pure JS)
- [ ] Dropping 7 mixed-category files greys out the unreachable ones and converts the rest

---

## 7. Scope decisions already made — do not reopen

- **~94 formats**, listed in `src/core/formats.ts`. Broad enough to mean "anything", narrow enough that every entry has a real engine behind it.
- **Excluded on purpose:** RAW camera formats, DjVu, iWork (`.pages`/`.numbers`/`.key`), MOBI/AZW, 3D/CAD, PostScript, JPEG XL/JP2, OCR, and **encoding** to HEIC (decode only — HEVC patents). See `docs/spec-engines.md` §C.
- **No LibreOffice bundled.** Detect a user install and prefer it when present; otherwise the pure-JS chain.
- **No cloud, no network, ever.** Any dependency that fetches at runtime is a bug.
- **Codec is not a user option.** Three options maximum, contextual per category, in one collapsed disclosure.
