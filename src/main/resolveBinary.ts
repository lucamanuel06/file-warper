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

export function resolveBinary(name: SidecarBinary): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', exe)
    : path.join(
        app.getAppPath(),
        'resources',
        'bin',
        process.platform === 'darwin' ? 'mac' : process.platform,
        process.arch,
        exe,
      );

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
