import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * `packages: 'external'` externalises every bare specifier — which would
 * include our own tsconfig path aliases, so `@converters/index` would be
 * `require`d at runtime and blow up with MODULE_NOT_FOUND. Rewriting the
 * aliases to absolute paths here makes esbuild bundle our own source while
 * still leaving real npm packages external.
 */
const alias = {
  '@core': `${root}src/core`,
  '@shared': `${root}src/shared`,
  '@converters': `${root}src/converters`,
  '@runtime': `${root}src/runtime`,
};

/**
 * Main and preload are compiled to **CJS**, deliberately:
 *   - a sandboxed renderer cannot have an ESM preload script, and we want
 *     `sandbox: true`;
 *   - ESM main only runs entry-point import side effects before `ready`, which
 *     silently breaks `registerSchemesAsPrivileged` ordering.
 *
 * `packages: 'external'` keeps every bare import resolving from node_modules at
 * runtime. That is the reliable choice here: several dependencies ship wasm
 * assets, native .node addons, or sidecar binaries that a bundler mangles.
 * electron-builder ships node_modules into the asar for us.
 */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',
  external: ['electron'],
  alias,
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  // esbuild's automatic tsconfig discovery only ever looks for a file
  // literally named `tsconfig.json` (the renderer config) walking up from
  // each source file — it would never find `tsconfig.node.json`, so
  // `@converters/*`/`@runtime/*` (declared only there) silently fail to
  // resolve and get left as an unresolved `require(...)` at runtime.
  tsconfig: 'tsconfig.node.json',
};

const entries = [
  { entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' },
  { entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js' },
  { entryPoints: ['src/runtime/worker/entry.ts'], outfile: 'dist/worker/entry.js' },
];

const ctxs = await Promise.all(entries.map((e) => esbuild.context({ ...common, ...e })));

if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[build-electron] watching…');
} else {
  await Promise.all(ctxs.map((c) => c.rebuild()));
  await Promise.all(ctxs.map((c) => c.dispose()));
}
