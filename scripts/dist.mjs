import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packages the app OUTSIDE the repository, then copies the distributable
 * archives back into ./release.
 *
 * Why: this project lives under ~/Documents, which macOS keeps in iCloud Drive.
 * The iCloud file provider stamps `com.apple.FinderInfo` onto every .app and
 * .framework directory and RE-ADDS IT WITHIN A SECOND of removal. codesign
 * hard-fails on that attribute ("resource fork, Finder information, or similar
 * detritus not allowed"), so signing can never win the race — an `afterPack`
 * hook that strips the attribute is defeated before codesign even starts.
 *
 * Building in a non-synced directory removes the cause instead of fighting it.
 * Override with WARP_RELEASE_DIR if you want it somewhere else.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const outDir =
  process.env.WARP_RELEASE_DIR ??
  path.join(homedir(), 'Library', 'Caches', 'file-warper', 'release');

mkdirSync(outDir, { recursive: true });

const args = [
  'electron-builder',
  '--mac',
  '--arm64',
  `-c.directories.output=${outDir}`,
  ...process.argv.slice(2),
];

const child = spawn('npx', args, { stdio: 'inherit', cwd: root });

child.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);

  // Copy the distributables back for convenience. The .app itself stays put:
  // moving it into iCloud would re-stamp FinderInfo, and while that does not
  // stop it launching, it would break any later re-sign.
  //
  // On CI, WARP_RELEASE_DIR is already ./release, so there is nothing to copy —
  // and cpSync onto itself throws.
  const localRelease = path.join(root, 'release');
  if (path.resolve(outDir) !== path.resolve(localRelease)) {
    mkdirSync(localRelease, { recursive: true });
    for (const f of readdirSync(outDir)) {
      if (f.endsWith('.dmg') || f.endsWith('.zip')) {
        cpSync(path.join(outDir, f), path.join(localRelease, f));
      }
    }
  }

  console.log('');
  console.log(`  App bundle : ${path.join(outDir, 'mac-arm64', 'File Warper.app')}`);
  console.log(`  Installers : ${localRelease}`);
  console.log('');
  console.log(
    `  Open it with:  open "${path.join(outDir, 'mac-arm64', 'File Warper.app')}"`,
  );
});
