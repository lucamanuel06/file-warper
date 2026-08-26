import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packages the app for one platform.
 *
 * Target selection: an explicit `--mac` / `--win` / `--linux` in the arguments
 * wins (that is what the `dist:mac` / `dist:win` / `dist:linux` scripts pass);
 * otherwise it builds for whatever OS you are on. electron-builder can only
 * cross-build with wine/Docker, which this project does not require — the CI
 * matrix builds each platform on its own runner instead.
 *
 * Output directory: `./release`, EXCEPT on macOS where it defaults outside the
 * repo. Reason: this project lives under ~/Documents, which macOS keeps in
 * iCloud Drive, and the iCloud file provider stamps `com.apple.FinderInfo` onto
 * every .app and .framework directory — RE-ADDING IT WITHIN A SECOND of
 * removal. codesign hard-fails on that attribute ("resource fork, Finder
 * information, or similar detritus not allowed"), so signing can never win the
 * race and an `afterPack` hook that strips it is defeated before codesign even
 * starts. Building in a non-synced directory removes the cause instead of
 * fighting it. Set WARP_RELEASE_DIR to override anywhere (CI always does).
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const passthrough = process.argv.slice(2);

const PLATFORM_FLAGS = ['--mac', '--win', '--linux'];
const explicit = passthrough.filter((a) => PLATFORM_FLAGS.includes(a));
const currentFlag =
  process.platform === 'darwin'
    ? '--mac'
    : process.platform === 'win32'
      ? '--win'
      : '--linux';
const platformFlags = explicit.length > 0 ? [] : [currentFlag];

const isMacBuild = (explicit[0] ?? currentFlag) === '--mac';

const outDir =
  process.env.WARP_RELEASE_DIR ??
  (isMacBuild && process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Caches', 'file-warper', 'release')
    : path.join(root, 'release'));

mkdirSync(outDir, { recursive: true });

const args = [
  'electron-builder',
  ...platformFlags,
  `-c.directories.output=${outDir}`,
  ...passthrough,
];

const child = spawn('npx', args, {
  stdio: 'inherit',
  cwd: root,
  shell: process.platform === 'win32',
});

child.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);

  // Copy the distributables back for convenience when we built elsewhere. The
  // .app itself stays put: moving it into iCloud would re-stamp FinderInfo, and
  // while that does not stop it launching, it would break any later re-sign.
  const localRelease = path.join(root, 'release');
  if (path.resolve(outDir) !== path.resolve(localRelease)) {
    mkdirSync(localRelease, { recursive: true });
    for (const f of readdirSync(outDir)) {
      if (/\.(dmg|zip|exe|AppImage|deb)$/.test(f)) {
        cpSync(path.join(outDir, f), path.join(localRelease, f));
      }
    }
    console.log(`\n  Installers : ${localRelease}`);
  }

  console.log(`  Build output: ${outDir}\n`);
});
