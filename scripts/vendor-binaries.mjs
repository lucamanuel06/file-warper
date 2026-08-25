import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the three sidecar binaries into `resources/bin/mac/arm64/` so
 * `electron-builder.yml`'s `extraResources` can ship them *outside* the
 * asar — an asar-packed binary can't be `exec`'d. `src/main/resolveBinary.ts`
 * resolves this same layout in dev.
 */

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const DEST_DIR = path.join(projectRoot, 'resources', 'bin', 'mac', 'arm64');

const ffprobe = require('@ffprobe-installer/ffprobe');
const sevenZip = require('7zip-bin');

/** @type {Array<{ name: string, src: string }>} */
const BINARIES = [
  { name: 'ffmpeg', src: require('ffmpeg-static') },
  { name: 'ffprobe', src: ffprobe.path },
  { name: '7za', src: sevenZip.path7za },
];

fs.mkdirSync(DEST_DIR, { recursive: true });

for (const { name, src } of BINARIES) {
  if (!fs.existsSync(src)) {
    throw new Error(`vendor-binaries: source binary missing for "${name}": ${src}`);
  }
  const dest = path.join(DEST_DIR, name);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`[vendor-binaries] ${name} -> ${path.relative(projectRoot, dest)}`);
}
