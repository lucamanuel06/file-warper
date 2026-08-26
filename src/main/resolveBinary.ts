/**
 * Sidecar binaries live in `extraResources`, never inside the asar — an
 * asar-packed binary can't be `exec`'d. `scripts/vendor-binaries.mjs` copies
 * them into `resources/bin/mac/arm64/` at build time; this resolves the same
 * layout in dev vs. the packaged app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export type SidecarBinary = 'ffmpeg' | 'ffprobe' | '7za';

/**
 * electron-builder's `${os}` vocabulary — `mac` / `win` / `linux`, which is NOT
 * Node's `process.platform`. `extraResources.from` in electron-builder.yml is
 * `resources/bin/${os}/${arch}`, so the dev path must use the same words or dev
 * looks in a directory `npm run vendor` never wrote to. Kept in sync with
 * `osFolder()` in scripts/vendor-binaries.mjs.
 */
export function osFolder(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'linux';
}

/** Exported for tests: the path layout, without touching the filesystem. */
export function sidecarPath(
  name: SidecarBinary,
  opts: {
    packaged: boolean;
    platform: NodeJS.Platform;
    arch: string;
    resourcesPath: string;
    appPath: string;
  },
): string {
  const exe = opts.platform === 'win32' ? `${name}.exe` : name;
  return opts.packaged
    ? path.join(opts.resourcesPath, 'bin', exe)
    : path.join(
        opts.appPath,
        'resources',
        'bin',
        osFolder(opts.platform),
        opts.arch,
        exe,
      );
}

export function resolveBinary(name: SidecarBinary): string {
  const binPath = sidecarPath(name, {
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });

  if (!fs.existsSync(binPath)) {
    throw new Error(`Missing sidecar binary: ${binPath}. Run \`npm run vendor\`.`);
  }
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
  } catch {
    // npm/git can drop the executable bit — restore it rather than fail.
    fs.chmodSync(binPath, 0o755);
  }
  return binPath;
}
