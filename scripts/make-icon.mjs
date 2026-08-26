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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

  // Linux wants a PNG; electron-builder also uses this as a generic fallback.
  const icon1024 = path.join(buildDir, 'icon.png');
  await renderPng(iconSvg, 1024, icon1024);
  console.log(`make-icon: wrote ${path.relative(root, icon1024)}`);

  // Windows wants an .ico. Built by hand because sharp has no ICO encoder:
  // the format is a 6-byte header, one 16-byte directory entry per image, then
  // the image payloads — and modern Windows accepts PNG-encoded entries, which
  // is what every size here is. 256px must be written as 0 in the width/height
  // byte, since the field is a single byte.
  const icoPath = path.join(buildDir, 'icon.ico');
  await writeIco(iconSvg, [16, 24, 32, 48, 64, 128, 256], icoPath);
  console.log(`make-icon: wrote ${path.relative(root, icoPath)}`);

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

/**
 * Assembles a multi-size .ico from PNG-encoded entries.
 *
 * Layout: ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image + payloads.
 * Windows Vista and later accept PNG payloads, which keeps this simple and
 * lossless — no BMP/AND-mask encoding needed.
 */
async function writeIco(svgPath, sizes, outPath) {
  const pngs = [];
  for (const size of sizes) {
    pngs.push({
      size,
      data: await sharp(svgPath, { density: 384 })
        .resize(size, size, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer(),
    });
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  const entrySize = 16;
  let offset = header.length + entrySize * pngs.length;
  const entries = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(entrySize);
    // 256 is stored as 0 — the field is one byte.
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette count
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  writeFileSync(outPath, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
