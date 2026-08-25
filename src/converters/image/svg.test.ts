import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SVG_FIXTURE } from './fixtures';
import { svgCompress } from './svg';
import { cleanupDir, fakeContext, fakeInput, makeTempDir } from './test-helpers';

let dir: string;
let svgPath: string;

beforeAll(async () => {
  dir = await makeTempDir('svg-');
  svgPath = path.join(dir, 'src.svg');
  await writeFile(svgPath, SVG_FIXTURE);
});

afterAll(async () => {
  await cleanupDir(dir);
});

describe('zlib:svgz', () => {
  it('supports only svg <-> svgz', () => {
    expect(svgCompress.supports?.('svg', 'svgz')).toBe(true);
    expect(svgCompress.supports?.('svgz', 'svg')).toBe(true);
    expect(svgCompress.supports?.('svg', 'svg')).toBe(false);
    expect(svgCompress.supports?.('svgz', 'svgz')).toBe(false);
  });

  it('svg -> svgz produces a valid gzip stream that decompresses back', async () => {
    const input = await fakeInput(svgPath, 'svg');
    const outPath = path.join(dir, 'out.svgz');

    const result = await svgCompress.convert(
      input,
      { path: outPath, format: 'svgz' },
      {},
      fakeContext(dir),
    );
    expect(result.bytes).toBeGreaterThan(0);

    const compressed = await readFile(outPath);
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
    const decompressed = gunzipSync(compressed);
    expect(decompressed.toString('utf8')).toBe(SVG_FIXTURE.toString('utf8'));
  });

  it('svgz -> svg round-trips exactly', async () => {
    const input = await fakeInput(svgPath, 'svg');
    const svgzPath = path.join(dir, 'roundtrip.svgz');
    await svgCompress.convert(
      input,
      { path: svgzPath, format: 'svgz' },
      {},
      fakeContext(dir),
    );

    const svgzInput = await fakeInput(svgzPath, 'svgz');
    const svgOut = path.join(dir, 'roundtrip.svg');
    const result = await svgCompress.convert(
      svgzInput,
      { path: svgOut, format: 'svg' },
      {},
      fakeContext(dir),
    );
    expect(result.bytes).toBe(SVG_FIXTURE.length);

    const back = await readFile(svgOut);
    expect(back.toString('utf8')).toBe(SVG_FIXTURE.toString('utf8'));
  });

  it('throws a structured ConversionError on garbage svgz input', async () => {
    const badPath = path.join(dir, 'bad.svgz');
    await writeFile(badPath, Buffer.from('not gzip data'));
    const input = await fakeInput(badPath, 'svgz');
    const outPath = path.join(dir, 'bad-out.svg');

    await expect(
      svgCompress.convert(input, { path: outPath, format: 'svg' }, {}, fakeContext(dir)),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });
});
