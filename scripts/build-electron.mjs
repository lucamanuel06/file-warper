import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

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
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
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
