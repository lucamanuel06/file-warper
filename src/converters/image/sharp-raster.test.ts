import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  animatedFixture,
  rasterFixture,
  rotatedJpegFixture,
  SVG_FIXTURE,
} from './fixtures';
import { sharpRaster } from './sharp-raster';
import { cleanupDir, fakeContext, fakeInput, makeTempDir } from './test-helpers';

const INPUTS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'] as const;
const OUTPUTS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'] as const;

let dir: string;
const fixtureCache = new Map<string, Buffer>();

async function fixturePath(format: (typeof INPUTS)[number]): Promise<string> {
  let buf = fixtureCache.get(format);
  if (!buf) {
    buf = await rasterFixture(format);
    fixtureCache.set(format, buf);
  }
  const p = path.join(dir, `src.${format}`);
  await writeFile(p, buf);
  return p;
}

beforeAll(async () => {
  dir = await makeTempDir('sharp-raster-');
});

afterAll(async () => {
  await cleanupDir(dir);
});

describe('sharp:raster supports()', () => {
  it('rejects identity pairs', () => {
    for (const f of OUTPUTS) {
      expect(sharpRaster.supports?.(f, f)).toBe(false);
    }
  });

  it('allows svg -> raster but never raster -> svg', () => {
    expect(sharpRaster.inputs).toContain('svg');
    expect(sharpRaster.outputs).not.toContain('svg');
  });
});

describe('sharp:raster cost()', () => {
  it('is lossless for png/tiff targets', () => {
    expect(sharpRaster.cost('jpeg', 'png').retention).toBe(1.0);
    expect(sharpRaster.cost('jpeg', 'tiff').retention).toBe(1.0);
  });

  it('is lossy for jpeg/webp/avif/gif targets', () => {
    for (const to of ['jpeg', 'webp', 'avif', 'gif'] as const) {
      expect(sharpRaster.cost('png', to).retention).toBeCloseTo(0.92);
    }
  });
});

describe('sharp:raster convert()', () => {
  for (const from of [...INPUTS, 'svg'] as const) {
    for (const to of OUTPUTS) {
      if (from === to) continue;
      it(`${from} -> ${to}`, async () => {
        const srcPath =
          from === 'svg' ? path.join(dir, 'src.svg') : await fixturePath(from);
        if (from === 'svg') await writeFile(srcPath, SVG_FIXTURE);

        const input = await fakeInput(srcPath, from);
        const outPath = path.join(dir, `out-${from}-${to}.${to === 'tiff' ? 'tif' : to}`);
        const ctx = fakeContext(dir);

        const result = await sharpRaster.convert(
          input,
          { path: outPath, format: to },
          { quality: 'balanced', maxSize: 'original' },
          ctx,
        );

        expect(result.bytes).toBeGreaterThan(0);
        const meta = await sharp(outPath).metadata();
        if (to === 'avif') {
          // sharp reports AVIF's container family, not the "avif" id.
          expect(meta.format).toBe('heif');
          expect(meta.compression).toBe('av1');
        } else {
          expect(meta.format).toBe(to);
        }
        expect(meta.width).toBeGreaterThan(0);
        expect(meta.height).toBeGreaterThan(0);
      });
    }
  }
});

describe('sharp:raster EXIF orientation', () => {
  it('honours orientation then strips EXIF', async () => {
    const buf = await rotatedJpegFixture();
    const srcPath = path.join(dir, 'rotated.jpeg');
    await writeFile(srcPath, buf);

    const before = await sharp(srcPath).metadata();
    expect(before.width).toBe(3);
    expect(before.height).toBe(2);
    expect(before.orientation).toBe(6);

    const input = await fakeInput(srcPath, 'jpeg');
    const outPath = path.join(dir, 'rotated-out.png');
    await sharpRaster.convert(
      input,
      { path: outPath, format: 'png' },
      { quality: 'balanced', maxSize: 'original' },
      fakeContext(dir),
    );

    const after = await sharp(outPath).metadata();
    expect(after.width).toBe(2);
    expect(after.height).toBe(3);
    expect(after.orientation).toBeUndefined();
    expect(after.exif).toBeUndefined();
  });
});

describe('sharp:raster max size', () => {
  it('never upscales', async () => {
    const srcPath = await fixturePath('png');
    const input = await fakeInput(srcPath, 'png');
    const outPath = path.join(dir, 'no-upscale.jpeg');

    await sharpRaster.convert(
      input,
      { path: outPath, format: 'jpeg' },
      { quality: 'balanced', maxSize: '4000' },
      fakeContext(dir),
    );

    const meta = await sharp(outPath).metadata();
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(2);
  });

  it('downscales to the longest edge without exceeding it', async () => {
    const big = await sharp({
      create: { width: 20, height: 10, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const srcPath = path.join(dir, 'big.png');
    await writeFile(srcPath, big);
    const input = await fakeInput(srcPath, 'png');
    const outPath = path.join(dir, 'downscaled.png');

    await sharpRaster.convert(
      input,
      { path: outPath, format: 'png' },
      { quality: 'balanced', maxSize: '10' },
      fakeContext(dir),
    );

    const meta = await sharp(outPath).metadata();
    expect(meta.width).toBeLessThanOrEqual(10);
    expect(meta.height).toBeLessThanOrEqual(10);
  });
});

describe('sharp:raster animated round-trip', () => {
  it('gif -> webp preserves frame count', async () => {
    const gifBuf = await animatedFixture('gif');
    const srcPath = path.join(dir, 'anim.gif');
    await writeFile(srcPath, gifBuf);
    const input = await fakeInput(srcPath, 'gif');
    const outPath = path.join(dir, 'anim-out.webp');

    await sharpRaster.convert(
      input,
      { path: outPath, format: 'webp' },
      { quality: 'balanced', maxSize: 'original' },
      fakeContext(dir),
    );

    const meta = await sharp(outPath, { animated: true }).metadata();
    expect(meta.pages).toBe(2);
  });

  it('webp -> gif preserves frame count', async () => {
    const webpBuf = await animatedFixture('webp');
    const srcPath = path.join(dir, 'anim2.webp');
    await writeFile(srcPath, webpBuf);
    const input = await fakeInput(srcPath, 'webp');
    const outPath = path.join(dir, 'anim2-out.gif');

    await sharpRaster.convert(
      input,
      { path: outPath, format: 'gif' },
      { quality: 'balanced', maxSize: 'original' },
      fakeContext(dir),
    );

    const meta = await sharp(outPath, { animated: true }).metadata();
    expect(meta.pages).toBe(2);
  });
});
