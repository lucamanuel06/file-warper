import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heicDecode } from './heic';
import { cleanupDir, fakeContext, fakeInput, makeTempDir } from './test-helpers';

let dir: string;
let heicPath: string | undefined;

beforeAll(async () => {
  dir = await makeTempDir('heic-decode-');

  // Synthesize a tiny real HEIC via the macOS `sips` utility (no encoder
  // exists in our dependency set — sharp/heic-decode are decode-only).
  const pngPath = path.join(dir, 'src.png');
  const candidateHeicPath = path.join(dir, 'src.heic');
  await writeFile(
    pngPath,
    await sharp(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), {
      raw: { width: 2, height: 2, channels: 3 },
    })
      .png()
      .toBuffer(),
  );
  try {
    execFileSync('sips', ['-s', 'format', 'heic', pngPath, '--out', candidateHeicPath], {
      stdio: 'ignore',
    });
    heicPath = candidateHeicPath;
  } catch {
    heicPath = undefined;
  }
});

afterAll(async () => {
  await cleanupDir(dir);
});

describe('heic-decode:png', () => {
  it('declares decode-only heic/heif -> png', () => {
    expect(heicDecode.inputs).toEqual(['heic', 'heif']);
    expect(heicDecode.outputs).toEqual(['png']);
  });

  it('converts heic -> png', async () => {
    if (!heicPath) {
      // `sips` unavailable (non-macOS host) — nothing to decode against.
      return;
    }
    const input = await fakeInput(heicPath, 'heic');
    const outPath = path.join(dir, 'out.png');

    const result = await heicDecode.convert(
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
  });

  it('throws a structured ConversionError on garbage input', async () => {
    const badPath = path.join(dir, 'bad.heic');
    await writeFile(badPath, Buffer.from('not a heic file at all'));
    const input = await fakeInput(badPath, 'heic');
    const outPath = path.join(dir, 'bad-out.png');

    await expect(
      heicDecode.convert(input, { path: outPath, format: 'png' }, {}, fakeContext(dir)),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });
});
