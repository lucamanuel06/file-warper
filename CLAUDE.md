# File Warper — working conventions

A macOS Electron app that converts essentially any file type into another, fully offline.

**Read `docs/PLAN.md` first.** Then the spec for your area:
`docs/spec-stack.md` (Electron/Next wiring) · `docs/spec-core-architecture.md` (converter contract, graph, jobs) · `docs/spec-engines.md` (which library, and the trap list) · `docs/spec-ui.md` (every UI state + tokens).

## Frozen files — never edit

- `src/core/types.ts` — the `Converter` / `Route` / `Job` contracts
- `src/core/formats.ts` — the ~94-format registry
- `src/shared/ipc.ts` — the whole main↔renderer surface
- `package.json` — the dependency set is settled and already installed

If you genuinely need a change in one of these, **report it instead of making it**. Five agents share these files; a silent edit breaks the other four.

## Ownership

Only edit files under the paths your brief assigns you. `node_modules` is shared — never run `npm install`.

## Commands

```bash
npx tsc -p tsconfig.node.json --noEmit   # main/preload/runtime/converters/core
npx tsc -p tsconfig.json --noEmit        # renderer (src/app, src/ui)
npx biome check src/<your-dir>           # lint + format
npx biome check --write src/<your-dir>   # autofix
npx vitest run src/<your-dir>            # tests
```

## Conventions

- **Module format:** `src/main`, `src/preload`, `src/runtime`, `src/converters` compile to **CJS** via esbuild. `src/app` and `src/ui` are ESM/React. `src/core` and `src/shared` must work in both — keep them dependency-free.
- **`file-type` is ESM-only.** From CJS, use `const { fileTypeFromFile } = await import('file-type')`.
- **Path aliases:** `@core/*`, `@shared/*`, `@converters/*`, `@runtime/*`, `@ui/*`.
- **Imports:** `import type` for anything type-only — it keeps `src/core` out of the renderer's runtime bundle.
- **No `any`.** Biome errors on it. Use `unknown` plus a narrowing check.
- **Strings shown to users** go in `userMessage` on `ConversionError`, and must read as a plain sentence: "This PDF is password-protected." — never "EACCES".
- **Never `outline: none`** without a `:focus-visible` replacement.
- **No network at runtime, ever.** A dependency that fetches something on first use is a bug, not a feature.

## Things that will bite you

- `sandbox: true` means the **preload has no Node builtins** — no `fs`, no `path`. Anything filesystem-shaped goes over IPC to main.
- `File.path` was removed in Electron 32. Use `webUtils.getPathForFile(file)`, called **synchronously** in the drop handler (`DataTransfer` is neutered after an `await`).
- `protocol.registerSchemesAsPrivileged` must run at module top level, **before** `app.whenReady()`, exactly once.
- Static binaries (`ffmpeg`, `ffprobe`, `7za`) go in `extraResources`, never inside the asar — asar-packed binaries cannot be `exec`'d. `sharp` needs `asarUnpack`.
- `printToPDF` needs `await document.fonts.ready` and `img.decode()` in-page first, or you get blank pages nondeterministically.
- Validate every archive entry path before extracting (`path.resolve(dest, name).startsWith(dest + sep)`). Zip-slip is the obvious attack on a converter.
- Never let a computed output path equal the input path. Force a suffix instead.

## Commit style

Conventional commits, scoped to your area: `feat(core): layered dijkstra router`, `fix(av): honour abort signal in ffmpeg adapter`. Commit as you go; do not push.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
