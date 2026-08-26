import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Verifies a packaged build. Cross-platform entry point.
 *
 * The check that matters on EVERY platform is the last one: the bundled
 * ffmpeg/ffprobe/7za must exist and actually execute. That is the single most
 * common breakage in this class of app — an asar-packed binary cannot be
 * exec'd, and a dropped executable bit silently produces "cannot open".
 *
 * macOS additionally gets the signature/Gatekeeper/plist checks, which are
 * real and hard-won; they are delegated to scripts/verify-app.sh so that logic
 * stays in one place.
 */

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const releaseDir =
  process.env.WARP_RELEASE_DIR ??
  (process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Caches', 'file-warper', 'release')
    : path.join(root, 'release'));

if (process.platform === 'darwin') {
  // Full macOS verification: codesign, spctl, plist, binaries.
  const appPath =
    process.env.WARP_PACKAGED_APP ??
    ['mac-arm64', 'mac-x64', 'mac']
      .map((d) => path.join(releaseDir, d, 'File Warper.app'))
      .find((p) => existsSync(p));

  if (!appPath) {
    fail(`no .app found under ${releaseDir} (run \`npm run dist\` first)`);
  }
  execFileSync('bash', [path.join(root, 'scripts', 'verify-app.sh'), appPath], {
    stdio: 'inherit',
  });
  process.exit(0);
}

// ── Windows / Linux ────────────────────────────────────────────────────────
// electron-builder writes the unpacked tree next to the installers.
const unpackedDir = ['win-unpacked', 'linux-unpacked', 'win-ia32-unpacked']
  .map((d) => path.join(releaseDir, d))
  .find((p) => existsSync(p));

if (!unpackedDir) {
  fail(`no unpacked build found under ${releaseDir} (run \`npm run dist\` first)`);
}
console.log(`== verifying ${unpackedDir} ==`);

const installers = readdirSync(releaseDir).filter((f) => /\.(exe|AppImage|deb)$/.test(f));
if (installers.length === 0) {
  fail(`no installers (.exe/.AppImage/.deb) produced in ${releaseDir}`);
}
for (const f of installers) {
  const size = statSync(path.join(releaseDir, f)).size;
  if (size < 1_000_000) fail(`${f} is suspiciously small (${size} bytes)`);
  console.log(`   installer ${f} (${Math.round(size / 1048576)} MB)`);
}

const exeSuffix = process.platform === 'win32' ? '.exe' : '';
const binDir = path.join(unpackedDir, 'resources', 'bin');
console.log('== bundled binaries are present, executable, and run ==');

for (const name of ['ffmpeg', 'ffprobe', '7za']) {
  const bin = path.join(binDir, `${name}${exeSuffix}`);
  if (!existsSync(bin)) {
    fail(`${name} missing from ${binDir} — did \`npm run vendor\` run before packaging?`);
  }
  if (process.platform !== 'win32') {
    try {
      accessSync(bin, constants.X_OK);
    } catch {
      fail(`${name} is not executable at ${bin}`);
    }
  }
  try {
    // 7za prints usage and exits non-zero with no args, so just probe ffmpeg
    // and ffprobe for a version banner and require 7za to merely spawn.
    if (name === '7za') {
      execFileSync(bin, [], { stdio: 'ignore' });
    } else {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
    }
  } catch (err) {
    // 7za's non-zero exit on no-args is expected; a spawn failure is not.
    if (name === '7za' && err.status !== undefined) {
      console.log('   7za spawned (non-zero exit with no args is expected)');
      continue;
    }
    fail(`bundled ${name} failed to run: ${err.message}`);
  }
  console.log(`   ${name} OK`);
}

console.log(`OK: ${unpackedDir} passed all checks.`);
