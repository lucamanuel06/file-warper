# File Warper

Convert anything into anything. Offline, on your Mac.

A single-window macOS app: drop files, pick one target format, hit Convert.
**90 formats, 1186 working conversions**, no cloud, no network, ever.

<!-- screenshot goes here -->

## What it converts

| | |
|---|---|
| **Images** | jpeg · png · webp · avif · gif · tiff · bmp · ico · svg — plus **HEIC and PSD in** |
| **Audio** | mp3 · wav · flac · aac · m4a · ogg · opus · aiff · ac3 · caf · au · mka |
| **Video** | mp4 · mov · mkv · webm · avi · m4v · 3gp · flv · mpeg · ts · ogv · y4m |
| **Documents** | pdf · docx · odt · rtf · txt · md · html · epub — plus **.doc in** |
| **Spreadsheets** | xlsx · ods · csv · tsv — plus **.xls in** |
| **Data** | json · yaml · toml · xml · jsonl · json5 · ini · properties · plist |
| **Archives** | zip · tar · tar.gz · tar.bz2 · tar.xz · gz · bz2 · xz · 7z — plus **rar/cab/iso extract** |
| **Fonts** | ttf · woff · woff2 · eot — plus **otf in** |
| **Subtitles** | srt · vtt · ass · ttml · sbv |

Conversions route through a format graph, so multi-hop paths work automatically:
`docx → html → pdf`, `heic → png → ico`, `mp4 → png → webp` (poster frame).
The picker only ever offers targets your files can actually reach.

### What it deliberately does not do

Honest limits, not missing features — see `docs/spec-engines.md` §C:

- **No HEIC output.** sharp's prebuilt libvips has no HEVC encoder (patents). Reading HEIC works fine.
- **No RAR output.** The unRAR license forbids building a RAR-compatible compressor. Extraction works.
- **No OCR**, no RAW camera formats, no iWork (`.pages`/`.numbers`/`.key`), no MOBI/AZW, no 3D/CAD.
- **Legacy `.ppt`** can't be read without LibreOffice. `.doc` comes out text-only.
- **PDF → DOCX is text-only.** There is no honest offline path that preserves layout.

Install LibreOffice and File Warper detects it automatically, unlocking
higher-fidelity Office conversions through it.

## Install

```bash
npm install
npm run dist
open ~/Library/Caches/file-warper/release/mac-arm64/File\ Warper.app
```

The `.dmg` lands in `release/`. It is ad-hoc signed, not notarized, so the first
launch needs a right-click → **Open** (or System Settings → Privacy & Security →
Open Anyway).

> The bundle is built outside the repo on purpose. This project lives under
> `~/Documents`, which macOS keeps in iCloud Drive, and the iCloud file provider
> stamps `com.apple.FinderInfo` onto every `.app` and `.framework` directory —
> which `codesign` refuses to sign, re-adding it within a second of removal.
> Set `WARP_RELEASE_DIR` to build somewhere else.

## Develop

```bash
npm run dev          # Next dev server + esbuild watch + Electron
npm run verify       # lint + typecheck + unit tests
npm test             # 585 unit + integration tests
npm run test:e2e     # 8 Playwright tests, incl. the packaged bundle
npm run verify:app   # codesign / Gatekeeper / plist / bundled-ffmpeg checks
```

## How it's built

```
src/core/         pure TS, zero deps — format registry, layered-Dijkstra router, detection
src/converters/   the engines (sharp, ffmpeg, pure-JS), one Converter object each
src/runtime/      scheduler, utilityProcess worker pool, temp manager
src/main/         Electron main, app:// protocol, IPC
src/preload/      the contextBridge surface
src/app + src/ui  Next.js renderer (static export)
```

Heavy work runs in a `utilityProcess` pool, so a libvips segfault or a 2 GB
decode kills one worker instead of the app. The final hop always writes to a
staging file on the output volume and `rename`s on success, so a cancelled or
failed conversion never leaves a truncated file behind — and never touches your
source.

Design decisions and the research behind them are in `docs/`:
`spec-stack.md` · `spec-core-architecture.md` · `spec-engines.md` · `spec-ui.md` · `PLAN.md`

## License

MIT. Bundles a GPL-3.0 ffmpeg binary, invoked as a separate process.
