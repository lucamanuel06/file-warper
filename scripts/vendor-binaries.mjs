import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the three sidecar binaries into `resources/bin/<os>/<arch>/` so
 * `electron-builder.yml`'s `extraResources` can ship them *outside* the asar —
 * an asar-packed binary can't be `exec`'d. `src/main/resolveBinary.ts` resolves
 * this same layout in dev.
 *
 * The `<os>` segment uses electron-builder's own vocabulary (`mac`, `win`,
 * `linux`), NOT Node's `process.platform` (`darwin`, `win32`, `linux`), because
 * `extraResources.from` is interpolated by electron-builder as
 * `resources/bin/${os}/${arch}`. Keep `osFolder()` here and the dev branch of
 * resolveBinary in agreement or dev and packaged disagree about where the
 * binaries live.
 *
 * Each package resolves the binary for the CURRENT platform, so running this on
 * a macOS/Windows/Linux runner vendors that platform's binaries. There is no
 * cross-vendoring: the CI matrix builds each platform on its own runner.
 */

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

/** electron-builder's `${os}` values. */
export function osFolder(platform = process.platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'linux';
}

const isWindows = process.platform === 'win32';
const exeSuffix = isWindows ? '.exe' : '';

const DEST_DIR = path.join(projectRoot, 'resources', 'bin', osFolder(), process.arch);

const ffprobe = require('@ffprobe-installer/ffprobe');
const sevenZip = require('7zip-bin');

/** @type {Array<{ name: string, src: string }>} */
const BINARIES = [
  { name: `ffmpeg${exeSuffix}`, src: require('ffmpeg-static') },
  { name: `ffprobe${exeSuffix}`, src: ffprobe.path },
  { name: `7za${exeSuffix}`, src: sevenZip.path7za },
];

fs.mkdirSync(DEST_DIR, { recursive: true });

for (const { name, src } of BINARIES) {
  if (!src || !fs.existsSync(src)) {
    throw new Error(
      `vendor-binaries: source binary missing for "${name}" on ${process.platform}/${process.arch}: ${src}`,
    );
  }
  const dest = path.join(DEST_DIR, name);
  fs.copyFileSync(src, dest);
  // Harmless on Windows, essential everywhere else.
  fs.chmodSync(dest, 0o755);
  console.log(`[vendor-binaries] ${name} -> ${path.relative(projectRoot, dest)}`);
}
