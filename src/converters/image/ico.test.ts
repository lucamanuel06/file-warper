import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { decode } from 'sharp-ico';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ico } from './ico';
import { cleanupDir, fakeContext, fakeInput, makeTempDir } from './test-helpers';

let dir: string;
let pngPath: string;

beforeAll(async () => {
  dir = await makeTempDir('ico-');
  pngPath = path.join(dir, 'src.png');
  await writeFile(
    pngPath,
    await sharp(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), {
      raw: { width: 2, height: 2, channels: 3 },
    })
      .png()
      .toBuffer(),
  );
});

afterAll(async () => {
  await cleanupDir(dir);
});

describe('sharp-ico:favicon', () => {
  it('supports only png/jpeg -> ico and ico -> png', () => {
    expect(ico.supports?.('png', 'ico')).toBe(true);
    expect(ico.supports?.('jpeg', 'ico')).toBe(true);
    expect(ico.supports?.('ico', 'png')).toBe(true);
    expect(ico.supports?.('png', 'jpeg')).toBe(false);
    expect(ico.supports?.('ico', 'jpeg')).toBe(false);
  });

  it('emits the standard favicon frame set', async () => {
    const input = await fakeInput(pngPath, 'png');
    const outPath = path.join(dir, 'out.ico');

    const result = await ico.convert(
      input,
      { path: outPath, format: 'ico' },
      {},
      fakeContext(dir),
    );
    expect(result.bytes).toBeGreaterThan(0);

    const buf = await readFile(outPath);
    const frames = decode(buf);
    expect(frames).toHaveLength(5);
    expect(new Set(frames.map((f) => f.width))).toEqual(new Set([16, 32, 48, 128, 256]));
  });

  it('ico -> png picks the largest frame losslessly', async () => {
    const icoPath = path.join(dir, 'roundtrip.ico');
    const input = await fakeInput(pngPath, 'png');
    await ico.convert(input, { path: icoPath, format: 'ico' }, {}, fakeContext(dir));

    const icoInput = await fakeInput(icoPath, 'ico');
    const outPath = path.join(dir, 'roundtrip-out.png');
    const result = await ico.convert(
      icoInput,
      { path: outPath, format: 'png' },
      {},
      fakeContext(dir),
    );

    expect(result.bytes).toBeGreaterThan(0);
    const meta = await sharp(outPath).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });
});
