# File Warper — Conversion Engine Spec

*All versions verified live against the npm registry on 2026-08-25.*

## 0. The three decisions that drive everything

1. **We already ship Chromium.** Use a hidden `BrowserWindow` + `webContents.printToPDF()` as the universal **-> PDF** renderer, and the same window's real `<canvas>` as the pdf.js rasterizer. Free (zero added bytes), best-in-class for CSS/fonts/emoji/RTL, and it removes puppeteer, headless-chrome, wkhtmltopdf and `@napi-rs/canvas` from the dependency graph entirely.
2. **HTML is the document hub.** Every document format converts *to* HTML or *from* HTML. `N` parsers + `M` writers instead of `N x M` converters. This is the only way "any -> any" is tractable.
3. **Native binaries are unavoidable for A/V, and that's fine.** ffmpeg as a *separately spawned process* keeps GPL out of our codebase and delivers 90% of the app's real-world value.

---

## A. Dependency list (exact names + verified versions)

### Images — primary: sharp
| Package | Version | Role |
|---|---|---|
| `sharp` | **0.35.3** | Primary raster engine (libvips) |
| `@img/sharp-darwin-arm64` | 0.35.3 | optionalDep, auto-selected |
| `@img/sharp-libvips-darwin-arm64` | 1.3.2 | 17.8 MB prebuilt libvips |
| `heic-decode` | **2.1.0** | HEIC/HEIF **decode** (sharp can't) |
| `ag-psd` | **31.0.2** | PSD/PSB read -> flattened RGBA |
| `sharp-ico` | **0.1.5** | ICO encode/decode on top of sharp |
| `svgo` | **4.1.0** | SVG -> SVG optimization |
| `jimp` | **1.6.1** | Pure-JS fallback: BMP + last-resort if sharp fails to load |

### Audio / Video — ffmpeg as a spawned binary
| Package | Version | Role |
|---|---|---|
| `ffmpeg-static` | **5.3.0** | ffmpeg **6.1.1**, macOS arm64 |
| `@ffprobe-installer/ffprobe` | **2.1.2** | ffprobe for metadata/duration/streams |
| `execa` | **10.0.1** | Process spawning with sane cancellation + streams |

**Do NOT use `fluent-ffmpeg`** — it carries an official npm deprecation notice. Build argv arrays by hand (~40 lines).

### Documents
| Package | Version | Role |
|---|---|---|
| `mammoth` | **1.12.1** | DOCX -> HTML (best-in-class pure JS) |
| `word-extractor` | **1.0.4** | Legacy `.doc` -> plain text (text only) |
| `marked` | **18.0.11** | MD -> HTML (GFM) |
| `turndown` + `turndown-plugin-gfm` | **7.2.4** / 1.0.2 | HTML -> MD |
| `html-to-text` | **10.0.1** | HTML -> TXT |
| `docx` | **9.7.1** | **Write** DOCX (builder API + our own HTML mapper) |
| `@lesjoursfr/html-to-epub` | **6.2.0** | HTML -> EPUB (maintained epub-gen fork) |
| `linkedom` | **0.18.13** | Fast DOM in the main process for HTML manipulation |
| `iconv-lite` + `chardet` | 0.7.3 / 2.2.0 | Legacy text encodings (Shift-JIS, CP1252, GB18030) |
| `shiki` | 4.4.3 | Code -> highlighted HTML (for code -> PDF) |

**PROJECT DECISION — do NOT use `officeparser@7.8.0`.** The research flagged it as attractive (one dep for ODT/ODP/ODS/PPTX/RTF/EPUB) but verification of its dependency tree shows:
```
tesseract.js ^7.0.0    <- downloads .traineddata from a CDN at first use -> breaks the offline guarantee
pdfjs-dist 6.1.200     <- a SECOND, pinned copy of pdfjs alongside our own 6.2.108
@xmldom/xmldom, fflate, file-type
```
Instead: **ODT / ODS / ODP / PPTX / EPUB are all ZIP + XML.** Read them directly with `fflate` + `fast-xml-parser`, which we already ship. ~100 lines per format, zero new dependencies, no OCR, no duplicate pdfjs, and full control over the offline guarantee.

### Spreadsheets — and the `xlsx` trap
**`xlsx` on npm is frozen at `0.18.5` (May 2022).** SheetJS moved distribution off the public registry to `cdn.sheetjs.com`; the stale registry copy carries known prototype-pollution and ReDoS advisories. **Do not `npm i xlsx`.**

| Package | Version | Role |
|---|---|---|
| `@e965/xlsx` | **0.20.3** | **Read** xlsx/xlsm/xlsb/**xls**/ods/csv — community republish of current SheetJS CE |
| `exceljs` | **4.4.0** | **Write** xlsx with styling/streaming |
| `papaparse` | **5.7.0** | CSV/TSV both directions |

A spreadsheet becomes `{sheets: [{name, rows: string[][]}]}` internally — from there -> CSV, JSON, HTML table, PDF, XLSX.

### PDF
| Package | Version | Role |
|---|---|---|
| `pdfjs-dist` | **6.2.108** | PDF -> text, PDF -> page raster (in the hidden renderer) |
| `@cantoo/pdf-lib` | **2.9.1** | Create/merge/split/rotate/stamp — **maintained fork**, API-compatible |
| *(Electron built-in)* | — | `printToPDF` for everything -> PDF |

Plain `pdf-lib@1.17.1` has not been published since 2022. Use the fork.

### Archives
| Task | Package | Version |
|---|---|---|
| Create ZIP (in-memory, tiny) | `fflate` | **0.8.3** |
| Create ZIP/TAR/TGZ from trees | `archiver` | **8.0.0** |
| Read ZIP (streaming, correct) | `yauzl` | **3.4.0** |
| tar / tar.gz / tar.bz2 | `tar` | **7.5.22** |
| gz / deflate / brotli | **`node:zlib`** | built-in |
| 7z, cab, iso, xz | `7zip-bin` + `node-7z` | **5.2.0** / 3.0.0 |
| RAR extract (no binary) | `node-unrar-js` | **2.0.2** |

`7zip-bin` is electron-builder's own dependency — continuously exercised by millions of builds despite its 2022 publish date. Treat as maintained-by-proxy.

### Data
| Format | Package | Version |
|---|---|---|
| YAML <-> JSON | **`yaml`** | 2.9.0 |
| XML <-> JSON | **`fast-xml-parser`** | 5.11.0 |
| TOML <-> JSON | **`smol-toml`** | 1.8.0 |
| CSV/TSV <-> JSON | **`papaparse`** | 5.7.0 |
| NDJSON/JSONL | none — 10 lines | — |

Pick `yaml@2.9.0` over `js-yaml`: preserves comments and formatting on round-trip, first-class TypeScript, exposes the CST for lossless edits.

### Fonts
`fonteditor-core@2.6.3` alone covers **ttf, otf, woff, woff2, eot, svg** in *both* directions, pure JS with a WASM woff2 codec. It replaces the entire `opentype.js` + `wawoff2` + `ttf2woff2` + `svg2ttf` constellation.

### Detection
`file-type@22.0.2` (magic bytes) + `mime-types@3.0.2` (extension <-> MIME).

---

## 1. Images — details

### What the sharp prebuilt actually gives you

`sharp@0.35.3` resolves `@img/sharp-darwin-arm64` + `@img/sharp-libvips-darwin-arm64` as optionalDependencies. npm picks them by `os`/`cpu` — no node-gyp, no compiler. **sharp is a Node-API (N-API) module, so it is ABI-stable across Node and Electron versions. It does NOT need `electron-rebuild`.** This is the single biggest reason to pick it.

| Format | In | Out |
|---|---|---|
| JPEG, PNG, WebP (incl. animated), AVIF, TIFF, GIF (incl. animated) | yes | yes |
| SVG | yes (librsvg) | no (raster->vector is not a thing) |
| **HEIC / HEIF** | **no** | **no** |
| JPEG 2000 / JPEG XL, BMP, ICO, PSD | no | no |
| RAW pixel buffers | yes | yes |

**HEIC is definitively absent from the prebuilt binaries** (HEVC patent licensing) and will not change. Enabling it means compiling libvips against libheif in CI and shipping our own dylibs. Not worth it.

**HEIC answer: `heic-decode@2.1.0`** (WASM libheif, LGPL-3.0, ~6.4 MB). Decode HEIC -> raw RGBA -> hand the buffer to `sharp({ raw: {...} })` to encode anything. Decode-only; **HEIC output is not feasible** and must be excluded from the UI.

### electron-builder packaging for sharp

```jsonc
{ "asarUnpack": ["**/node_modules/sharp/**/*", "**/node_modules/@img/**/*"] }
```
Mandatory — this is what the sharp docs prescribe. Without it the `.node` addon `dlopen`s from non-deterministic temp paths and libvips' dylib isn't found. Also set `files` to exclude the non-darwin `@img/*` platform packages or we ship ~150 MB of Linux/Windows libvips we'll never run.

### ICO / BMP / PSD
- **ICO**: `sharp-ico@0.1.5`. ICO is just a container of PNG/BMP frames — resize to 16/32/48/128/256 with sharp, wrap. **Killer feature for a converter app** (favicon generation), near-zero cost.
- **BMP**: `jimp` (via `@jimp/js-bmp`). Both directions. sharp cannot.
- **PSD**: `ag-psd@31.0.2` — actively maintained (v31), reads PSD/PSB composite + layers. Read-only; do not offer -> PSD.

### Rejected image alternatives
`wasm-vips@0.0.18` (pre-1.0, browser-oriented, 3-5x slower for nothing), `@jsquash/*` (assembling 4+ packages to reimplement sharp), `@imagemagick/magick-wasm@0.0.42` (0.0.x, ~30 MB, enormous API surface), `psd@3.4.0` (dead 2022).

---

## 2. Audio / Video — details

### Why `ffmpeg-static@5.3.0`

| | `ffmpeg-static` | `@ffmpeg-installer/ffmpeg` | ffmpeg.wasm |
|---|---|---|---|
| ffmpeg version | **6.1.1** | **4.1** (2019!) | ~6.0 core |
| Delivery | postinstall download | optionalDependencies tarball | npm tarball |
| Size | ~78 MB | ~37 MB | ~32 MB |
| Speed | native, VideoToolbox | native | **5-15x slower**, ~2 GB file ceiling |

`@ffmpeg-installer` being on 4.1 in 2026 is the tell that it's abandoned — a five-year gap covering AV1, improved VideoToolbox, and a mountain of CVEs. ffmpeg.wasm needs `SharedArrayBuffer` (COOP/COEP headers), caps out at wasm32's address space, and is *still* GPL — no upside inside Electron.

**Mitigate ffmpeg-static's one weakness, the postinstall download:** `scripts/vendor-ffmpeg.mjs` copies `require('ffmpeg-static')` and the ffprobe path into `resources/bin/` at build time; `extraResources` ships them. Resolve at runtime with `resolveBinary()` (see the stack spec). `chmod 0o755`. Purge `node_modules` before repackaging for a different platform.

### Licensing — the part that actually matters

Every prebuilt ffmpeg on npm is **GPL** (compiled `--enable-gpl` with x264/x265). There is no LGPL escape hatch on npm.

- **Invoke ffmpeg as a separate process via `execa`, never link it.** Under that arrangement our TypeScript is not a derivative work; we are *distributing* a GPL binary alongside a separate program — the same posture dozens of shipping Electron apps take.
- **Obligations when shipping:** include ffmpeg's `COPYING.GPLv3` + `LICENSE.md` in the bundle, surface them in an About/Licenses screen, and provide corresponding source for the exact build (a written offer + URL satisfies GPLv3 §6).
- **GPLv3 is incompatible with the Mac App Store.** For a notarized DMG / direct download we're fine. If MAS is ever on the roadmap, ffmpeg-static is a dead end.

### ffprobe
`ffmpeg-static` ships **only ffmpeg, not ffprobe**. Add `@ffprobe-installer/ffprobe@2.1.2` (optionalDependencies, no install-time download, confirmed arm64). Avoid `ffprobe-static@3.1.0` (README still references dead Zeranoe builds).

`ffprobe -v quiet -print_format json -show_format -show_streams` drives the UI: duration, codecs, resolution, bitrate, and *whether the file even has a video stream* — this is what lets a minimalist UI be smart and offer "-> MP3" only when there's an audio stream.

**Remux without re-encode (`-c copy`) when only the container changes** — instant, lossless, and the right default. Hardware-accelerated H.264/HEVC via `-c:v h264_videotoolbox` on Apple Silicon.

---

## 3. Documents — details

### 3.1 LibreOffice: optional detected engine, never a requirement

`soffice --convert-to` is by a wide margin the highest-fidelity offline converter for Office formats. Bundling it is not realistic: ~700 MB-1 GB unpacked, needs a writable profile dir, and embedding it inside our `.app` breaks its internal path assumptions and creates a codesigning nightmare (hundreds of nested dylibs).

**At startup, probe for** `/Applications/LibreOffice.app/Contents/MacOS/soffice`, `~/Applications/...`, and `which soffice`. If found, light up a "High-fidelity Office conversions" capability and let the router prefer those 1-hop edges. If not, fall back to the pure-JS chain and mention in one unobtrusive line that installing LibreOffice unlocks better Office fidelity.

**Do not use `libreoffice-convert@1.8.2`.** Spawn `soffice` yourself — the critical flag the wrapper makes awkward is `-env:UserInstallation=file:///tmp/fw-<uuid>`; without a unique profile per invocation, a second concurrent conversion silently fails or hangs. Always pass `--headless --norestore --invisible --nolockcheck --nodefault`.

### 3.2 pandoc: skip for v1

There is **no maintained npm package that bundles a pandoc binary.** `pandoc-bin@0.2.0` is dead (2022, depends on `bin-wrapper@3` + `chalk@0.4`, downloads at install). `node-pandoc@0.3.0` is dead and requires a system install. `@shogobg/pandoc` **does not exist**. Vendoring official pandoc (~180 MB, GPL-2.0+) would more than double app size for conversions the pure-JS chain mostly covers. Treat pandoc exactly like LibreOffice: **detect an existing system install, use it if present.**

### 3.3 The pure-JS chain — this is v1

**Everything routes through HTML.**

**Parsers (X -> HTML):**
- **DOCX**: `mammoth@1.12.1`. Deliberately semantic — maps Word styles to clean HTML rather than pixel-perfect junk. Images come out as data URIs, exactly what `printToPDF` wants.
- **ODT / ODS / ODP / PPTX / EPUB**: **write our own** with `fflate` + `fast-xml-parser` (see the officeparser decision above). All are ZIP + XML.
- **Legacy `.doc`**: `word-extractor@1.0.4` -> plain text only. The binary format hasn't changed since 1997 so staleness is acceptable. Be upfront in the UI: `.doc` -> text-fidelity only.
- **RTF**: small hand-rolled tokenizer (control words + groups) -> HTML. Adequate for the 95% case.
- **Markdown**: `marked@18.0.11` — smaller and faster than markdown-it, GFM built in.
- **CSV**: `papaparse` -> HTML `<table>`.
- **HTML**: pass through, but **inline every asset as a data URI** first (walk the DOM with `linkedom`). Never let the print window make a network request.

**Writers (HTML -> Y):**
- **-> PDF**: Electron `printToPDF` (§3.4).
- **-> MD**: `turndown` + `turndown-plugin-gfm`.
- **-> TXT**: `html-to-text`.
- **-> DOCX**: `docx@9.7.1` plus a hand-written HTML->docx mapper. **`html-to-docx@1.8.0` is a trap** — unmaintained since 2023-03, known breakage on modern Node, nested lists and images. Budget ~250-400 lines mapping `h1-h6 / p / strong / em / u / s / ul / ol / li / table / img / a / code / blockquote / hr` to docx builder calls. **This is the single largest custom-code item in the project.** Everything outside that subset is dropped — an acceptable, documentable contract.
- **-> EPUB**: `@lesjoursfr/html-to-epub@6.2.0` (the maintained fork; `epub-gen@0.1.0` is dead and fetches remote images). Pre-inline all images anyway.

### 3.4 PDF

**HTML -> PDF via `webContents.printToPDF`.** Confirmed API: `pageSize`, `margins`, `landscape`, `printBackground`, `scale`, `preferCSSPageSize`, `pageRanges`, `displayHeaderFooter` + templates, and experimentally `generateTaggedPDF` / `generateDocumentOutline`. Resolves to a `Buffer`.

Gotchas in order of likelihood:
1. **Wait properly.** `did-finish-load` is not enough. Execute in-page `await document.fonts.ready` and await all `img.decode()`. Otherwise: blank or unstyled pages, nondeterministically.
2. **`@page` CSS wins.** `landscape` is *ignored* if the document has `@page` rules. Either strip `@page` or set `preferCSSPageSize: true`.
3. **Lock the window down.** `{ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, offscreen: true } }`. We render arbitrary user files — treat every one as hostile.
4. **Serve via the custom protocol**, not `file://`.
5. **No PDF/A, no PDF/X.** That's LibreOffice or nothing.

This one mechanism gives `md/docx/html/csv/txt/epub/odt/rtf/json/yaml/xml/code/image -> pdf`.

**PDF -> text**: `pdfjs-dist` `getTextContent()` per page. Group items by `transform[5]` (y) for lines, x-gaps for words. Multi-column and table-heavy PDFs come out scrambled — say so in the UI.

**PDF -> images**: pdf.js `page.render()` into a real Chromium `<canvas>` in the hidden window, then `toDataURL`. **This is why the hidden-window approach pays twice** — no `@napi-rs/canvas`, no native build complexity.

**PDF -> DOCX**: there is **no good offline JS path**. Best available is pdfjs text extraction -> paragraph reconstruction -> `docx` writer. Layout, tables and images are lost. Ship it labeled **"text only"** or not at all.

**`mupdf@1.28.0` — the trap you must not fall into.** Technically superb, but **AGPL-3.0-or-later** and linked in-process; its copyleft would extend to all of File Warper, and Artifex actively enforces this. **Excluded.**

Other PDF traps: `pdf2pic` (needs GraphicsMagick + Ghostscript, also AGPL), `node-poppler` (needs Homebrew poppler), `pdf-parse` (wraps a *second* pinned pdfjs + native canvas), `textract` (dead 2023, shells out to `antiword`/`pdftotext`/`unrtf`).

---

## B. Realistic offline coverage

**Legend:** OK = high fidelity · ~ = works, lossy/partial · LO = only with detected system LibreOffice · X = excluded

### Images
| From \ To | JPEG | PNG | WebP | AVIF | TIFF | GIF | BMP | ICO | PDF | SVG |
|---|---|---|---|---|---|---|---|---|---|---|
| JPEG/PNG/WebP/AVIF/TIFF/GIF | OK | OK | OK | OK | OK | OK | OK | OK | OK | X |
| **HEIC/HEIF** | OK | OK | OK | OK | OK | OK | OK | OK | OK | X |
| SVG | OK | OK | OK | OK | OK | ~ | OK | OK | OK | OK (svgo) |
| BMP | OK | OK | OK | OK | OK | OK | OK | OK | OK | X |
| PSD | OK | OK | OK | OK | OK | ~ | OK | OK | OK | X |
| **-> HEIC** | X | X | X | X | X | X | X | X | X | X |

Animated GIF <-> animated WebP round-trips via sharp (`{animated: true}`). GIF from video -> ffmpeg with a palette filter.

### Audio / Video (ffmpeg — near-total coverage)
Any video (mp4/mov/mkv/webm/avi/wmv/flv/m4v/mpg/ts) -> any video container, any audio format, GIF, or PNG frames: **OK**.
Any audio (mp3/wav/flac/aac/m4a/ogg/opus/wma/aiff/caf) -> any audio format: **OK**. Audio -> video: X.

### Documents
| From \ To | PDF | DOCX | HTML | MD | TXT | EPUB | XLSX | CSV | JSON |
|---|---|---|---|---|---|---|---|---|---|
| MD | OK | ~ | OK | — | OK | OK | X | X | X |
| HTML | OK | ~ | — | OK | OK | OK | ~ | ~ | X |
| DOCX | OK | — | OK | OK | OK | OK | X | X | X |
| **DOC** (legacy) | ~LO | ~LO | ~LO | ~ | ~ | ~ | X | X | X |
| ODT | OK | ~LO | OK | OK | OK | OK | X | X | X |
| RTF | OK | ~LO | OK | OK | OK | ~ | X | X | X |
| PPTX | ~LO | ~ | ~ | ~ | OK | X | X | X | X |
| XLSX / XLS / ODS | OK | ~ | OK | ~ | OK | X | OK | OK | OK |
| CSV | OK | ~ | OK | OK | OK | X | OK | — | OK |
| EPUB | OK | ~ | OK | OK | OK | — | X | X | X |
| **PDF** | merge/split OK | ~ text-only | ~ | ~ | OK | ~ | X | X | X |
| TXT / code | OK | OK | OK | ~ | — | OK | X | X | X |

Also: PDF -> PNG/JPEG per page OK; images -> single PDF OK; PDF merge/split/rotate/extract-pages OK.

### Data / Archives / Fonts
- **Data — all OK:** JSON <-> YAML <-> TOML <-> XML <-> CSV <-> TSV <-> NDJSON, plus all -> PDF/HTML/TXT. *Caveat: CSV<->JSON needs flat data; XML<->JSON needs a convention choice. Surface one "flatten nested keys with `.`" toggle and refuse gracefully otherwise.*
- **Archives — all OK:** ZIP <-> TAR <-> TAR.GZ <-> TAR.BZ2 <-> 7Z; GZ/BZ2/XZ/BR single-file; RAR/ISO/CAB **extract only**.
- **Fonts:** TTF <-> WOFF <-> WOFF2 <-> EOT <-> SVG font lossless; OTF -> TTF is a **lossy outline conversion** (CFF cubic -> glyf quadratic, hinting lost) — label "best effort".

---

## C. Explicitly NOT feasible offline — exclude

1. **-> HEIC/HEIF encoding.** Patent-encumbered. (Decode is fine.)
2. **-> JPEG XL, -> JPEG 2000.** Not in the sharp prebuilt.
3. **-> PSD, -> AI, -> EPS, -> INDD.** Adobe formats are read-only at best.
4. **-> RAR.** Legally prohibited by the unRAR license. Don't show it in the UI at all.
5. **MOBI / AZW / AZW3, either direction.** No maintained library; KindleGen is dead and was never redistributable.
6. **DWG, DXF, STEP, IGES, 3DS, SKP** — 3D/CAD generally. DWG has no free reader at all.
7. **PDF -> editable, layout-faithful DOCX.** Text-only extraction is the honest ceiling.
8. **PDF/A, PDF/X, archival PDF.** `generateTaggedPDF` is accessibility tagging, not PDF/A conformance.
9. **OCR.** `tesseract.js` fetches language models from a CDN at first use — that breaks the offline guarantee outright.
10. **Anything needing an undetected system install:** Ghostscript, GraphicsMagick, poppler-utils, antiword, catdoc, unrtf, wkhtmltopdf.
11. **`.pages`, `.numbers`, `.key`** (Apple iWork). Undocumented Snappy/IWA protobuf containers.
12. **DRM'd anything** — protected EPUB/AZW, encrypted PDFs without the password.

---

## D. Trap list — packages to avoid

| Package | Why |
|---|---|
| **`mupdf`** 1.28.0 | **AGPL-3.0-or-later**, linked in-process. Would force AGPL on all of File Warper. |
| **`xlsx`** 0.18.5 | Frozen 2022; SheetJS left npm. Prototype-pollution/ReDoS advisories. Use `@e965/xlsx`. |
| **`fluent-ffmpeg`** 2.1.3 | **Official npm deprecation notice.** Spawn ffmpeg directly. |
| **`html-to-docx`** 1.8.0 | Unmaintained since 2023-03; breaks on modern Node, nested lists, images. |
| **`officeparser`** 7.8.0 | Pulls `tesseract.js` (CDN downloads) **and** a second pinned `pdfjs-dist@6.1.200`. |
| **`pandoc-bin`** / **`node-pandoc`** | Dead (2022); decade-old vulnerable dep chain / requires system install. |
| **`textract`** 2.5.0 | Dead (2023); shells out to `antiword`/`pdftotext`/`unrtf`. |
| **`pdf2pic`** / **`node-poppler`** | Require GraphicsMagick+Ghostscript / Homebrew poppler. Ghostscript is AGPL. |
| **`adm-zip`** 0.6.0 | Repeated zip-slip CVEs; loads whole archives into memory. |
| **`unzipper`** 0.12.5 | Sporadic maintenance, zip64 stream edge cases. Use `yauzl`. |
| **`decompress`** 4.2.1 | Abandoned; deep vulnerable dep tree. |
| **`epub-gen`** 0.1.0 | Dead (2022) and **fetches remote images** — silently breaks offline mode. |
| **`psd`** 3.4.0 | Dead (2022), CoffeeScript-derived. Use `ag-psd`. |
| **`wawoff2`** 2.0.1 | Dead (2022). `fonteditor-core` includes woff2. |
| **`@iarna/toml`** 2.2.5 | Abandoned (2020), TOML 0.5 only. Use `smol-toml`. |
| **`ffprobe-static`** 3.1.0 | README still references dead Zeranoe builds. Use `@ffprobe-installer/ffprobe`. |
| **`@ffmpeg-installer/ffmpeg`** | Ships **ffmpeg 4.1** — five years old, unpatched CVEs. |
| **`@ffmpeg/ffmpeg`** (wasm) | 5-15x slower, needs SharedArrayBuffer, ~2 GB ceiling, *still* GPL. |
| **`libreoffice-convert`** 1.8.2 | Thin wrapper that makes `-env:UserInstallation` isolation awkward -> concurrency hangs. |
| **`pdf-lib`** 1.17.1 | Not dangerous, just frozen since 2022. Use `@cantoo/pdf-lib`. |

**Archive safety, non-negotiable:** validate every entry path (`path.resolve(dest, name).startsWith(dest + sep)`) before writing. A converter that extracts untrusted archives is a prime zip-slip target.

---

## E. File type detection

`file-type@22.0.2` is **ESM-only** (`type: 'module'`, `engines.node >= 22`). There will be no CJS build. Since we bundle the main process with esbuild, the ESM/CJS question largely evaporates; otherwise use `const { fileTypeFromFile } = await import('file-type')` from CJS. **Do not** pin `file-type@16.5.4` to dodge it — its signature database is five years out of date.

**Critical limitation:** `file-type` is magic-bytes only and deliberately does **not** detect text formats — no CSV, JSON, YAML, TOML, Markdown, SVG, HTML or TXT. Those are a large share of a converter's traffic, so use a three-stage chain:

1. **Magic bytes** — `fileTypeFromFile()`. Authoritative when it hits.
2. **Extension** — `mime-types` + our own map. Covers most text formats.
3. **Content sniff** — strip BOM, validate UTF-8/UTF-16 (`chardet` + `iconv-lite` for legacy encodings), then in order: `<?xml`/`<svg` -> SVG/XML; `<!DOCTYPE html`/`<html` -> HTML; `JSON.parse` -> JSON; every line parses as JSON -> NDJSON; `smol-toml` parse -> TOML; **`yaml` parse LAST** (YAML is a JSON superset and will happily "succeed" on almost anything); consistent delimiter counts per line -> CSV/TSV; otherwise TXT.

Two more musts: **never trust the extension over magic bytes** for binary formats, and **disambiguate ZIP containers** — `docx`, `xlsx`, `pptx`, `odt`, `epub`, `jar` all report as `application/zip`; peek at `[Content_Types].xml` / `mimetype` inside the archive.

---

## F. Bundle size reality check

| Component | Approx. |
|---|---|
| Electron (arm64, packaged) | ~180 MB |
| ffmpeg 6.1.1 static | ~78 MB |
| ffprobe | ~18 MB |
| sharp + libvips-darwin-arm64 | ~18 MB |
| pdfjs-dist (trimmed to `build/` + cmaps + standard_fonts) | ~10 MB |
| libheif-js (WASM) | ~6.5 MB |
| 7za | ~2 MB |
| Everything else pure-JS (bundled/minified) | ~15 MB |
| **Realistic `.app`** | **~330-350 MB** |

Levers if too big: prune non-darwin `@img/*` via `files` (~150 MB of dead weight), or drop ffprobe and parse `ffmpeg -i` stderr (saves 18 MB, fussier code — keep ffprobe).

---

## G. Build order

1. **Detection + Data + Archives** — pure JS, zero risk, immediately useful.
2. **Images (sharp + HEIC)** — highest user demand per unit of effort. HEIC->JPEG alone justifies the app on a Mac.
3. **A/V (ffmpeg)** — solve binary bundling early; it's the highest-risk packaging item.
4. **Documents via the HTML hub + printToPDF** — biggest code investment, especially the HTML->DOCX mapper.
5. **Optional LibreOffice detection** — small, high-leverage once fallbacks exist.
6. **Fonts and EPUB** as polish.
