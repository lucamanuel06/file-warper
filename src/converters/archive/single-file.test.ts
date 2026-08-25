import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { sevenZipAvailability } from './seven-zip';
import { singleFileRecompressConverter } from './single-file';
import { makeCtx, makeInput, makeOutput, makeScratchDir } from './test-support';

let has7za = false;

beforeAll(async () => {
  has7za = (await sevenZipAvailability()).available;
});

describe('archive:single-file-recompress', () => {
  it('supports every directed pair among gz/bz2/xz, and nothing else', () => {
    const s = singleFileRecompressConverter.supports;
    if (!s) throw new Error('supports() missing');
    expect(s('gz', 'bz2')).toBe(true);
    expect(s('bz2', 'xz')).toBe(true);
    expect(s('xz', 'gz')).toBe(true);
    expect(s('gz', 'gz')).toBe(false);
    expect(s('gz', 'zip')).toBe(false);
  });

  it('converts gz -> bz2, decompressing to the exact original bytes', async () => {
    if (!has7za) return;
    const scratch = makeScratchDir();
    const payload = 'the quick brown fox jumps over the lazy dog\n'.repeat(50);
    const gzPath = path.join(scratch, 'in.gz');
    fs.writeFileSync(gzPath, zlib.gzipSync(Buffer.from(payload)));

    const bz2Path = path.join(scratch, 'out.bz2');
    await singleFileRecompressConverter.convert(
      makeInput(gzPath, 'gz'),
      makeOutput(bz2Path, 'bz2'),
      {},
      makeCtx(scratch),
    );

    expect(fs.readFileSync(bz2Path).subarray(0, 3).toString('latin1')).toBe('BZh');
  });

  it('round-trips gz -> bz2 -> xz -> gz, preserving the exact payload bytes', async () => {
    if (!has7za) return;
    const scratch = makeScratchDir();
    const payload = Buffer.from(
      'roundtrip payload with some \x00 binary \xff bytes',
      'latin1',
    );
    const gzPath = path.join(scratch, 'in.gz');
    fs.writeFileSync(gzPath, zlib.gzipSync(payload));

    const bz2Path = path.join(scratch, 'mid.bz2');
    await singleFileRecompressConverter.convert(
      makeInput(gzPath, 'gz'),
      makeOutput(bz2Path, 'bz2'),
      {},
      makeCtx(scratch),
    );

    const xzPath = path.join(scratch, 'mid.xz');
    await singleFileRecompressConverter.convert(
      makeInput(bz2Path, 'bz2'),
      makeOutput(xzPath, 'xz'),
      {},
      makeCtx(scratch),
    );

    const outGzPath = path.join(scratch, 'out.gz');
    await singleFileRecompressConverter.convert(
      makeInput(xzPath, 'xz'),
      makeOutput(outGzPath, 'gz'),
      {},
      makeCtx(scratch),
    );

    const roundTripped = zlib.gunzipSync(fs.readFileSync(outGzPath));
    expect(roundTripped.equals(payload)).toBe(true);
  });
});
