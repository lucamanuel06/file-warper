#!/usr/bin/env node
/**
 * Renders build/icon.svg into every PNG size macOS needs and assembles
 * build/icon.icns via the system `iconutil`. Also emits build/icon.png
 * (1024, electron-builder's fallback) and, if build/dmg-background.svg
 * exists, build/dmg-background.png (+@2x).
 *
 * Run by hand after editing build/icon.svg or build/dmg-background.svg:
 *
 *   node scripts/make-icon.mjs
 *
 * Its output (build/icon.iconset/**, build/icon.icns, build/icon.png,
 * build/dmg-background*.png) is committed — packaging does not regenerate
 * it, so re-run this and commit the result whenever the source SVG changes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(root, 'build');
const iconSvg = path.join(buildDir, 'icon.svg');
const iconsetDir = path.join(buildDir, 'icon.iconset');
const icnsPath = path.join(buildDir, 'icon.icns');

function checkIconutil() {
  try {
    execFileSync('which', ['iconutil'], { stdio: 'ignore' });
  } catch {
    console.error(
      '\nmake-icon: `iconutil` was not found on PATH.\n' +
        'It ships with macOS (part of the developer tools) and is required to assemble\n' +
        'build/icon.icns from the rendered PNGs. Run this script on a Mac.\n',
    );
    process.exit(1);
  }
}

// Apple's iconset filenames: base size + the pixel size actually rendered.
const ICONSET_ENTRIES = [
  { file: 'icon_16x16.png', size: 16 },
  { file: 'icon_16x16@2x.png', size: 32 },
  { file: 'icon_32x32.png', size: 32 },
  { file: 'icon_32x32@2x.png', size: 64 },
  { file: 'icon_128x128.png', size: 128 },
  { file: 'icon_128x128@2x.png', size: 256 },
  { file: 'icon_256x256.png', size: 256 },
  { file: 'icon_256x256@2x.png', size: 512 },
  { file: 'icon_512x512.png', size: 512 },
  { file: 'icon_512x512@2x.png', size: 1024 },
];

async function renderPng(svgPath, size, outPath) {
  await sharp(svgPath).resize(size, size).png().toFile(outPath);
}

async function main() {
  if (!existsSync(iconSvg)) {
    console.error(`make-icon: missing ${path.relative(root, iconSvg)}`);
    process.exit(1);
  }
  checkIconutil();

  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });

  for (const { file, size } of ICONSET_ENTRIES) {
    await renderPng(iconSvg, size, path.join(iconsetDir, file));
  }
  console.log(
    `make-icon: wrote ${ICONSET_ENTRIES.length} PNGs to ${path.relative(root, iconsetDir)}`,
  );

  rmSync(icnsPath, { force: true });
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath], {
    stdio: 'inherit',
  });
  console.log(`make-icon: wrote ${path.relative(root, icnsPath)}`);

  const icon1024 = path.join(buildDir, 'icon.png');
  await renderPng(iconSvg, 1024, icon1024);
  console.log(`make-icon: wrote ${path.relative(root, icon1024)}`);

  const dmgBgSvg = path.join(buildDir, 'dmg-background.svg');
  if (existsSync(dmgBgSvg)) {
    const dmgBg1x = path.join(buildDir, 'dmg-background.png');
    const dmgBg2x = path.join(buildDir, 'dmg-background@2x.png');
    await sharp(dmgBgSvg).resize(540, 380).png().toFile(dmgBg1x);
    await sharp(dmgBgSvg).resize(1080, 760).png().toFile(dmgBg2x);
    console.log(
      `make-icon: wrote ${path.relative(root, dmgBg1x)} and ${path.relative(root, dmgBg2x)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
