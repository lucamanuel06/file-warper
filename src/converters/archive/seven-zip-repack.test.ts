import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import * as tar from 'tar';
import { beforeAll, describe, expect, it } from 'vitest';
import { sevenAdd, sevenRename, sevenZipAvailability } from './seven-zip';
import { sevenZipRepackConverter } from './seven-zip-repack';
import { makeCtx, makeInput, makeOutput, makeScratchDir } from './test-support';

const encode = (s: string) => new TextEncoder().encode(s);

let has7za = false;

beforeAll(async () => {
  has7za = (await sevenZipAvailability()).available;
});

function buildFixtureZip(): Uint8Array {
  return zipSync({
    'a.txt': encode('hello'),
    'dir/b.txt': encode('world'),
  });
}

describe('archive:seven-zip-repack', () => {
  it('supports pairs touching 7z/tar.bz2/tar.xz but not zip<->tar<->tar.gz (owned by the pure-js converter)', () => {
    const s = sevenZipRepackConverter.supports;
    if (!s) throw new Error('supports() missing');
    expect(s('zip', '7z')).toBe(true);
    expect(s('7z', 'zip')).toBe(true);
    expect(s('tar', 'tar.bz2')).toBe(true);
    expect(s('tar.xz', 'tar.gz')).toBe(true);
    expect(s('zip', 'tar')).toBe(false);
    expect(s('tar', 'tar.gz')).toBe(false);
    expect(s('zip', 'zip')).toBe(false);
  });

  it('converts zip -> 7z -> zip round trip, preserving content', async () => {
    if (!has7za) return;
    const scratch = makeScratchDir();
    const zipPath = path.join(scratch, 'in.zip');
    fs.writeFileSync(zipPath, buildFixtureZip());

    const sevenZipPath = path.join(scratch, 'mid.7z');
    await sevenZipRepackConverter.convert(
      makeInput(zipPath, 'zip'),
      makeOutput(sevenZipPath, '7z'),
      {},
      makeCtx(scratch),
    );
    expect(fs.existsSync(sevenZipPath)).toBe(true);
    expect(fs.statSync(sevenZipPath).size).toBeGreaterThan(0);

    const outZipPath = path.join(scratch, 'out.zip');
    await sevenZipRepackConverter.convert(
      makeInput(sevenZipPath, '7z'),
      makeOutput(outZipPath, 'zip'),
      {},
      makeCtx(scratch),
    );

    const roundTripped = unzipSync(fs.readFileSync(outZipPath));
    expect(Buffer.from(roundTripped['a.txt'] as Uint8Array).toString('utf8')).toBe(
      'hello',
    );
    expect(Buffer.from(roundTripped['dir/b.txt'] as Uint8Array).toString('utf8')).toBe(
      'world',
    );
  });

  it('converts tar -> tar.bz2 -> tar round trip via the 7za bzip2 pipeline', async () => {
    if (!has7za) return;
    const scratch = makeScratchDir();
    const srcDir = path.join(scratch, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
    const tarPath = path.join(scratch, 'in.tar');
    await tar.create({ file: tarPath, cwd: srcDir, gzip: false }, ['a.txt']);

    const bz2Path = path.join(scratch, 'out.tar.bz2');
    await sevenZipRepackConverter.convert(
      makeInput(tarPath, 'tar'),
      makeOutput(bz2Path, 'tar.bz2'),
      {},
      makeCtx(scratch),
    );
    expect(fs.readFileSync(bz2Path).subarray(0, 3).toString('latin1')).toBe('BZh');

    const outTarPath = path.join(scratch, 'roundtrip.tar');
    await sevenZipRepackConverter.convert(
      makeInput(bz2Path, 'tar.bz2'),
      makeOutput(outTarPath, 'tar'),
      {},
      makeCtx(scratch),
    );
    const extractDir = path.join(scratch, 'extracted');
    fs.mkdirSync(extractDir);
    await tar.extract({ file: outTarPath, cwd: extractDir });
    expect(fs.readFileSync(path.join(extractDir, 'a.txt'), 'utf8')).toBe('hello');
  });

  it('converts tar -> tar.xz, producing a real xz stream', async () => {
    if (!has7za) return;
    const scratch = makeScratchDir();
    const srcDir = path.join(scratch, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
    const tarPath = path.join(scratch, 'in.tar');
    await tar.create({ file: tarPath, cwd: srcDir, gzip: false }, ['a.txt']);

    const xzPath = path.join(scratch, 'out.tar.xz');
    await sevenZipRepackConverter.convert(
      makeInput(tarPath, 'tar'),
      makeOutput(xzPath, 'tar.xz'),
      {},
      makeCtx(scratch),
    );
    const head = fs.readFileSync(xzPath).subarray(0, 6);
    expect(Array.from(head)).toEqual([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  });

  it('availability reflects the bundled 7za binary being usable', async () => {
    const availability = await sevenZipRepackConverter.availability();
    expect(availability.available).toBe(has7za);
  });

  it('refuses to extract a 7z archive containing a zip-slip path', async () => {
    if (!has7za) return;
    const scratch = makeScratchDir();
    const srcDir = path.join(scratch, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'ok.txt'), 'pwned');
    const sevenZipPath = path.join(scratch, 'evil.7z');
    await sevenAdd(sevenZipPath, path.join(srcDir, 'ok.txt'), '7z');
    // Rename the entry, post hoc, to something that escapes the destination
    // once resolved — this is exactly what `sevenList` + `assertAllSafe`
    // must catch before `extractFull` ever runs.
    await sevenRename(sevenZipPath, [['ok.txt', '../../evil.txt']]);

    const outZipPath = path.join(scratch, 'out.zip');
    await expect(
      sevenZipRepackConverter.convert(
        makeInput(sevenZipPath, '7z'),
        makeOutput(outZipPath, 'zip'),
        {},
        makeCtx(scratch),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });

    expect(fs.existsSync(path.join(os.tmpdir(), 'evil.txt'))).toBe(false);
  });
});
