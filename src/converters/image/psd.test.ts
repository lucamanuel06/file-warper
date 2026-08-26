import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writePsd } from 'ag-psd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { psdDecode } from './psd';
import { ensureCanvasShim } from './psd-canvas-shim';
import { sharp } from './sharp-init';
import { cleanupDir, fakeContext, fakeInput, makeTempDir } from './test-helpers';

let dir: string;
let psdPath: string;

beforeAll(async () => {
  dir = await makeTempDir('psd-decode-');
  ensureCanvasShim();

  const width = 2;
  const height = 2;
  const data = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  const buf = writePsd(
    {
      width,
      height,
      channels: 4,
      bitsPerChannel: 8,
      imageResources: {},
      imageData: { data, width, height },
    },
    {},
  );
  psdPath = path.join(dir, 'src.psd');
  await writeFile(psdPath, Buffer.from(buf));
});

afterAll(async () => {
  await cleanupDir(dir);
});

describe('ag-psd:png', () => {
  it('declares read-only psd -> png', () => {
    expect(psdDecode.inputs).toEqual(['psd']);
    expect(psdDecode.outputs).toEqual(['png']);
  });

  it('converts psd -> png', async () => {
    const input = await fakeInput(psdPath, 'psd');
    const outPath = path.join(dir, 'out.png');

    const result = await psdDecode.convert(
      input,
      { path: outPath, format: 'png' },
      {},
      fakeContext(dir),
    );

    expect(result.bytes).toBeGreaterThan(0);
    const meta = await sharp(outPath).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(2);

    const pixels = await sharp(outPath).raw().toBuffer();
    expect(Array.from(pixels.subarray(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('throws a structured ConversionError on garbage input', async () => {
    const badPath = path.join(dir, 'bad.psd');
    await writeFile(badPath, Buffer.from('not a psd file'));
    const input = await fakeInput(badPath, 'psd');
    const outPath = path.join(dir, 'bad-out.png');

    await expect(
      psdDecode.convert(input, { path: outPath, format: 'png' }, {}, fakeContext(dir)),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });
});
