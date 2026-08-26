import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bmp } from './bmp';
import { sharp } from './sharp-init';
import { cleanupDir, fakeContext, fakeInput, makeTempDir } from './test-helpers';

let dir: string;
let pngPath: string;

beforeAll(async () => {
  dir = await makeTempDir('bmp-');
  pngPath = path.join(dir, 'src.png');
  const pngBuf = await sharp(
    Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    {
      raw: { width: 2, height: 2, channels: 3 },
    },
  )
    .png()
    .toBuffer();
  await writeFile(pngPath, pngBuf);
});

afterAll(async () => {
  await cleanupDir(dir);
});

describe('jimp:bmp', () => {
  it('supports only png <-> bmp', () => {
    expect(bmp.supports?.('png', 'bmp')).toBe(true);
    expect(bmp.supports?.('bmp', 'png')).toBe(true);
    expect(bmp.supports?.('png', 'png')).toBe(false);
    expect(bmp.supports?.('bmp', 'bmp')).toBe(false);
  });

  it('png -> bmp', async () => {
    const input = await fakeInput(pngPath, 'png');
    const outPath = path.join(dir, 'out.bmp');

    const result = await bmp.convert(
      input,
      { path: outPath, format: 'bmp' },
      {},
      fakeContext(dir),
    );
    expect(result.bytes).toBeGreaterThan(0);

    const magic = (await readFile(outPath)).subarray(0, 2);
    expect(magic.toString('ascii')).toBe('BM');
  });

  it('bmp -> png round-trips pixel data losslessly', async () => {
    const input = await fakeInput(pngPath, 'png');
    const bmpOut = path.join(dir, 'roundtrip.bmp');
    await bmp.convert(input, { path: bmpOut, format: 'bmp' }, {}, fakeContext(dir));

    const bmpInput = await fakeInput(bmpOut, 'bmp');
    const pngOut = path.join(dir, 'roundtrip.png');
    const result = await bmp.convert(
      bmpInput,
      { path: pngOut, format: 'png' },
      {},
      fakeContext(dir),
    );

    expect(result.bytes).toBeGreaterThan(0);
    const meta = await sharp(pngOut).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(2);
  });
});
