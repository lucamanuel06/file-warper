# File Warper — Electron + Next.js + TypeScript Stack Spec

*Versions verified against the live npm registry on 2026-08-25.*

## 1. Architecture — verdict

**Hand-rolled `next build` with `output: 'export'`, served in production through a custom `app://` protocol handler via `protocol.handle()` + `net.fetch()`. No server process.**

Why not the alternatives:

- **Next production server inside Electron** — spawns a real HTTP listener, costs ~300-600 ms of startup, opens a localhost port any local process can hit, breaks if the port is taken, and makes packaging drag in the whole `node_modules` server tree. Rejected.
- **Nextron 10.3.0** (published 2026-08-21, does support Next 16) — alive and would work, but wraps main-process compilation in its own webpack 5 + `ts-loader` pipeline, pins its own TypeScript (ships `typescript6` as an npm alias), forces a `main/` + `renderer/` layout, and puts a single-maintainer abstraction between us and `electron-builder`. With an ffmpeg sidecar you'll fight it. Rejected.
- **`loadFile()` + `file://`** — verified against a real Next 16 exported page: asset URLs are emitted as **absolute** `/_next/static/chunks/….js`. Under `file://` those resolve to filesystem root and 404. The `assetPrefix: './'` trick rewrites them relative, but then any route below the root (`/convert/`) resolves `./_next/…` against the wrong directory — you'd be locked to a single flat page. The `app://` handler maps `/_next/...` to `out/_next/...` at any depth, and gives a **secure origin** (`crypto.subtle`, service workers, normal CSP headers all work — `file://` gives none of that).

## 2. Exact versions (verified `npm view`)

```jsonc
{
  "dependencies": { "next": "16.3.3", "react": "19.2.8", "react-dom": "19.2.8" },
  "devDependencies": {
    "electron": "43.4.1",           // latest is 44.0.0 — released 2026-08-24, one day old. Pin 43.x.
    "electron-builder": "26.15.3",
    "typescript": "6.0.3",          // NOT 7.x — see below
    "esbuild": "0.28.2",
    "@types/node": "26.3.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.2",
    "concurrently": "10.0.5",
    "wait-on": "9.1.0"
  }
}
```

**TypeScript: pin `6.0.3`, do not install 7.** TypeScript 7.0 (GA 2026-07-08) is the Go port and ships **no `typescript/lib/typescript.js` programmatic API**; Next resolves TS through exactly that API. Confirmed inside `next@16.3.3`: `dist/lib/verify-typescript-setup.js` advertises `install: 'typescript@^6.0.0'`, and the TS7 path is gated behind `experimental.useTypeScriptCli: true`. The stable API lands in TS 7.1. Revisit then.

**Bundler for main+preload: `esbuild` directly** (not tsup, not vite, not electron-vite). Two entry points, ~25 lines, no abstraction.

**Packager: `electron-builder` 26.15.3.** Forge is more moving parts; `@electron/packager` alone won't give a DMG.

## 3. Module format — the decisive rule

**Main: CJS. Preload: CJS. Renderer: whatever Next emits.**

From Electron's own ESM docs: a **sandboxed renderer cannot have an ESM preload script**. Since we want `sandbox: true` (see §7), the preload *must* be CJS. ESM main has a real footgun: "only side effects from the entry point's imports execute before the `ready` event," which silently breaks `registerSchemesAsPrivileged` ordering. Keep root `package.json` **without** `"type": "module"`. `next.config.ts` still works — Next compiles it itself.

**`scripts/build-electron.mjs`**
```js
import * as esbuild from 'esbuild';
const watch = process.argv.includes('--watch');
const common = {
  bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  external: ['electron'], sourcemap: true, minify: !watch, logLevel: 'info',
};
const ctxs = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/main/index.ts'],   outfile: 'dist/main/index.js' }),
  esbuild.context({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js' }),
]);
if (watch) await Promise.all(ctxs.map(c => c.watch()));
else { await Promise.all(ctxs.map(c => c.rebuild())); await Promise.all(ctxs.map(c => c.dispose())); }
```

Native deps (`sharp`) and sidecar-spawning modules must be listed in `external` too, and shipped as real `node_modules` in the asar — never bundled by esbuild.

**`next.config.ts`**
```ts
import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'export',
  distDir: '.next',
  trailingSlash: true,          // out/convert/index.html — clean 1:1 path mapping
  images: { unoptimized: true },// REQUIRED: next/image has no optimizer in export
  // assetPrefix: DO NOT SET. Absolute /_next/* is correct under app://.
};
export default config;
```
`output: 'export'` writes to `out/`. Turbopack is the default builder in Next 16 (`--webpack` is the opt-out).

**tsconfigs** — three, so `next build` never type-checks Electron code.

`tsconfig.json` (renderer, the one Next reads):
```jsonc
{ "compilerOptions": { "target":"ES2022","lib":["DOM","DOM.Iterable","ES2022"],"jsx":"preserve",
  "module":"esnext","moduleResolution":"bundler","strict":true,"noEmit":true,"skipLibCheck":true,
  "allowJs":true,"esModuleInterop":true,"isolatedModules":true,"incremental":true,
  "plugins":[{"name":"next"}],"paths":{"@shared/*":["./src/shared/*"]} },
  "include":["next-env.d.ts","src/renderer/**/*.ts","src/renderer/**/*.tsx","src/shared/**/*.ts",".next/types/**/*.ts"],
  "exclude":["node_modules","src/main","src/preload","out","dist"] }
```

`tsconfig.node.json` (main + preload, type-check only):
```jsonc
{ "compilerOptions": { "target":"ES2022","lib":["ES2023"],"module":"commonjs",
  "moduleResolution":"node","types":["node","electron"],"strict":true,"noEmit":true,
  "skipLibCheck":true,"esModuleInterop":true,"paths":{"@shared/*":["./src/shared/*"]} },
  "include":["src/main/**/*.ts","src/preload/**/*.ts","src/shared/**/*.ts"] }
```

`src/shared/` must contain **types and constants only** — no `import { ipcRenderer } from 'electron'` — or the Next build pulls Electron into the browser graph.

## 4. Production loading: the `app://` handler

```ts
// src/main/protocol.ts
import { app, net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_ORIGIN = 'app://warper';

// MUST run at module top level, before app.whenReady(), and only once.
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  }]);
}

export function serveExport(outDir: string) {
  protocol.handle('app', async (req) => {
    const { pathname } = new URL(req.url);
    // trailingSlash:true => "/" and "/convert/" map to index.html
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    const target = path.join(outDir, rel);
    const relCheck = path.relative(outDir, target);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return new Response('Forbidden', { status: 403 });

    const res = await net.fetch(pathToFileURL(target).toString());
    if (res.status === 404) return net.fetch(pathToFileURL(path.join(outDir, '404.html')).toString());

    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy',
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'");
    return new Response(res.body, { status: res.status, headers });
  });
}
```

`'unsafe-inline'` in `script-src` is **unavoidable**: Next's exported HTML contains an inline `self.__next_f.push(...)` bootstrap, and nonces are derived from a *request* CSP header at render time — which static export cannot do. Mitigate by keeping `default-src 'none'` and `connect-src 'self'`; there is no remote origin to exfiltrate to.

**Window + dev/prod switch:**
```ts
const DEV_URL = process.env.ELECTRON_RENDERER_URL; // set only by the dev script
const win = new BrowserWindow({
  width: 900, height: 620, show: false, titleBarStyle: 'hiddenInset',
  backgroundColor: '#0b0b0c',
  webPreferences: {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
  },
});
win.once('ready-to-show', () => win.show());
DEV_URL ? win.loadURL(DEV_URL) : win.loadURL(`${APP_ORIGIN}/`);
```

**Scripts:**
```jsonc
"dev": "concurrently -k \"next dev src/renderer -p 3000\" \"node scripts/build-electron.mjs --watch\" \"wait-on tcp:3000 && cross-env ELECTRON_RENDERER_URL=http://localhost:3000 electron .\"",
"build": "next build src/renderer && node scripts/build-electron.mjs",
"dist": "npm run build && electron-builder --mac --arm64",
"typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.node.json"
```
Next Fast Refresh works untouched in the Electron window. `--watch` on esbuild rebuilds main/preload but does **not** restart Electron; quit and re-run for main-process edits.

## 5. Type-safe IPC

**`src/shared/ipc.ts`** (types only — safe for both graphs):
```ts
export type IpcInvokeMap = {
  'dialog:pickFiles': (filters?: string[]) => Promise<string[]>;
  'warp:probe':       (paths: string[])    => Promise<ProbeResult[]>;
  'warp:targets':     (formats: string[])  => Promise<TargetSet>;
  'warp:enqueue':     (req: EnqueueRequest)=> Promise<{ batchId: string; jobs: JobSummary[] }>;
  'warp:cancelJob':   (jobId: string)      => Promise<void>;
  'warp:cancelBatch': (batchId: string)    => Promise<void>;
  'warp:availability':()                   => Promise<Record<string, Availability>>;
};
export type IpcEventMap = { 'warp:events': WarpEvent[] };
```

**`src/preload/index.ts`** — CJS, sandbox-safe (only `require('electron')`):
```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { IpcInvokeMap, IpcEventMap } from '../shared/ipc';

const CHANNELS = ['dialog:pickFiles','warp:probe','warp:targets','warp:enqueue',
                  'warp:cancelJob','warp:cancelBatch','warp:availability'] as const;
const EVENTS   = ['warp:events'] as const;

const api = {
  invoke: <C extends keyof IpcInvokeMap>(ch: C, ...args: Parameters<IpcInvokeMap[C]>): ReturnType<IpcInvokeMap[C]> => {
    if (!CHANNELS.includes(ch as any)) throw new Error(`blocked channel ${String(ch)}`);
    return ipcRenderer.invoke(ch, ...args) as ReturnType<IpcInvokeMap[C]>;
  },
  on: <E extends keyof IpcEventMap>(ev: E, cb: (p: IpcEventMap[E]) => void): (() => void) => {
    if (!EVENTS.includes(ev as any)) throw new Error(`blocked event ${String(ev)}`);
    const h = (_e: IpcRendererEvent, p: IpcEventMap[E]) => cb(p);
    ipcRenderer.on(ev, h);
    return () => { ipcRenderer.off(ev, h); };   // returning the disposer is essential — see below
  },
};
export type WarperApi = typeof api;
contextBridge.exposeInMainWorld('warper', api);
```

**`src/renderer/warper.d.ts`**: `declare global { interface Window { warper: import('../preload').WarperApi } } export {};`
This is an `import type` — Next never bundles the preload. The **disposer-return** pattern matters: `contextBridge` cannot pass a function reference back across the bridge for later `off()`, so a renderer that calls `on()` in a `useEffect` and tries to unsubscribe with the raw handler will leak listeners on every re-render. Returning the closure from inside the bridge is the fix.

Main streams progress with `win.webContents.send('warp:events', payloadArray)` — typed by importing `IpcEventMap` and wrapping `send` in one helper.

## 6. macOS packaging (arm64, unsigned)

**`electron-builder.yml`**
```yaml
appId: com.lucamanuel.filewarper
productName: File Warper
directories: { output: release, buildResources: build }
files:
  - dist/**                      # bundled main + preload
  - out/**                       # Next static export
  - package.json
  - '!**/*.map'
extraResources:
  - from: resources/bin/${os}/${arch}
    to: bin
    filter: ['**/*']
asar: true
# asarUnpack is NOT needed for extraResources (they live outside app.asar already).
# Use it only if a native .node addon ends up inside the asar:
asarUnpack: ['**/*.node', '**/node_modules/sharp/**']
mac:
  target: [{ target: dmg, arch: [arm64] }, { target: zip, arch: [arm64] }]
  category: public.app-category.utilities
  identity: '-'          # ad-hoc sign — REQUIRED on Apple Silicon
  hardenedRuntime: false # ad-hoc + hardened runtime => library-validation failures
  notarize: false
  gatekeeperAssess: false
dmg:
  contents:
    - { x: 130, y: 220, type: file }
    - { x: 410, y: 220, type: link, path: /Applications }
```

**The unsigned-build landmine, stated precisely:** `identity: null` skips signing *entirely*, and on arm64 that produces an app macOS reports as **"damaged"** — electron-builder's repackaging invalidates the linker's automatic ad-hoc signature, and arm64 refuses to load unsigned Mach-O. `identity: '-'` makes electron-builder ad-hoc sign the bundle, which is what a local unsigned build needs. Keep `hardenedRuntime: false`. First launch still needs one right-click -> Open (or System Settings -> Privacy & Security -> Open Anyway).

**Sidecar path resolution — `src/main/resolveBinary.ts`:**
```ts
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export function resolveBinary(name: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', exe)   // …/File Warper.app/Contents/Resources/bin/ffmpeg
    : path.join(app.getAppPath(), 'resources', 'bin',
        process.platform === 'darwin' ? 'mac' : process.platform, process.arch, exe);
  if (!fs.existsSync(p)) throw new Error(`Missing sidecar binary: ${p}`);
  try { fs.accessSync(p, fs.constants.X_OK); } catch { fs.chmodSync(p, 0o755); }
  return p;
}
```
Commit the binary with the exec bit set; npm/git can drop it, hence the `chmodSync` guard. Never `spawn` it through a shell — pass an argv array so paths with spaces (very likely, given `Contents/Resources`) survive.

## 7. Remaining landmines, checklist form

| Landmine | Setting |
|---|---|
| `sandbox` | `true`. Forces CJS preload (ESM preload is unsupported in a sandboxed renderer). |
| `contextIsolation` / `nodeIntegration` | `true` / `false`. Non-negotiable; `false` here plus `'unsafe-inline'` CSP is remote-code-execution on the filesystem. |
| `registerSchemesAsPrivileged` | Top-level module scope, **before** `app.whenReady()`, called exactly once. Called late = silent `about:blank`. |
| `next/image` | `images.unoptimized: true` or the export build errors out. |
| Dev CSP | Don't apply the prod CSP in dev — HMR needs `'unsafe-eval'`. The header is set only inside `protocol.handle`, which dev never hits. |
| Routing | `trailingSlash: true`, and handle bare `/foo` (no slash) in the handler by appending `/index.html` too, or a mistyped link white-screens. |
| Deprecated protocol APIs | `registerFileProtocol` / `registerStreamProtocol` are deprecated since Electron 25. Use `protocol.handle` only. |
| `will-navigate` / `setWindowOpenHandler` | Deny both, route external links through `shell.openExternal`. Without it a dropped `.html` can navigate the shell window off-origin. |
| Electron 44 | Released 2026-08-24 (Chromium 152 / Node 24.18.1). Pin **43.4.1** until 44.1.x. |

---

**Sources:** [Electron ESM docs](https://www.electronjs.org/docs/latest/tutorial/esm) · [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol) · [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) · [Next.js TS7 support discussion](https://github.com/vercel/next.js/discussions/95633) · [electron-builder macOS docs](https://www.electron.build/docs/mac/) · [electron-builder code signing](https://www.electron.build/docs/features/code-signing/code-signing-mac/) · [Nextron](https://github.com/saltyshiomix/nextron)
