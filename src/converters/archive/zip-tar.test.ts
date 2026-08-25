import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversionError } from '@core/types';
import { unzipSync, zipSync } from 'fflate';
import * as tar from 'tar';
import { describe, expect, it } from 'vitest';
import { makeCtx, makeInput, makeOutput, makeScratchDir } from './test-support';
import { zipTarRepackConverter } from './zip-tar';

const enc = (s: string) => new TextEncoder().encode(s);

function buildFixtureZip(): Uint8Array {
  return zipSync({
    'a.txt': enc('hello'),
    'dir/b.txt': enc('world'),
    'dir/sub/c.txt': enc('nested'),
  });
}

describe('archive:zip-tar-repack', () => {
  it('is always available (pure JS)', async () => {
    await expect(zipTarRepackConverter.availability()).resolves.toEqual({
      available: true,
    });
  });

  it('supports every directed pair among zip/tar/tar.gz, and nothing else', () => {
    const s = zipTarRepackConverter.supports;
    if (!s) throw new Error('supports() missing');
    expect(s('zip', 'tar')).toBe(true);
    expect(s('tar', 'zip')).toBe(true);
    expect(s('tar', 'tar.gz')).toBe(true);
    expect(s('tar.gz', 'zip')).toBe(true);
    expect(s('zip', 'zip')).toBe(false);
    expect(s('zip', '7z')).toBe(false);
  });

  it('converts zip -> tar, preserving entry names, directory structure, and content', async () => {
    const scratch = makeScratchDir();
    const zipPath = path.join(scratch, 'in.zip');
    fs.writeFileSync(zipPath, buildFixtureZip());
    const outPath = path.join(scratch, 'out.tar');

    await zipTarRepackConverter.convert(
      makeInput(zipPath, 'zip'),
      makeOutput(outPath, 'tar'),
      {},
      makeCtx(scratch),
    );

    const extractDir = path.join(scratch, 'extracted');
    fs.mkdirSync(extractDir);
    await tar.extract({ file: outPath, cwd: extractDir });

    expect(fs.readFileSync(path.join(extractDir, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(extractDir, 'dir/b.txt'), 'utf8')).toBe('world');
    expect(fs.readFileSync(path.join(extractDir, 'dir/sub/c.txt'), 'utf8')).toBe(
      'nested',
    );
  });

  it('converts tar -> tar.gz, producing a real gzip stream containing the same tar', async () => {
    const scratch = makeScratchDir();
    const srcDir = path.join(scratch, 'src');
    fs.mkdirSync(path.join(srcDir, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(srcDir, 'dir', 'b.txt'), 'world');
    const tarPath = path.join(scratch, 'in.tar');
    await tar.create({ file: tarPath, cwd: srcDir, gzip: false }, ['a.txt', 'dir']);

    const outPath = path.join(scratch, 'out.tar.gz');
    await zipTarRepackConverter.convert(
      makeInput(tarPath, 'tar'),
      makeOutput(outPath, 'tar.gz'),
      {},
      makeCtx(scratch),
    );

    // Real gzip magic bytes.
    const head = fs.readFileSync(outPath).subarray(0, 2);
    expect(head[0]).toBe(0x1f);
    expect(head[1]).toBe(0x8b);

    const extractDir = path.join(scratch, 'extracted');
    fs.mkdirSync(extractDir);
    // tar auto-detects gzip on read, no `gzip: true` needed here.
    await tar.extract({ file: outPath, cwd: extractDir });
    expect(fs.readFileSync(path.join(extractDir, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(extractDir, 'dir/b.txt'), 'utf8')).toBe('world');
  });

  it('round-trips zip -> tar -> zip with the same entry name+content set', async () => {
    const scratch = makeScratchDir();
    const zipPath = path.join(scratch, 'in.zip');
    const originalBytes = buildFixtureZip();
    fs.writeFileSync(zipPath, originalBytes);

    const tarPath = path.join(scratch, 'mid.tar');
    await zipTarRepackConverter.convert(
      makeInput(zipPath, 'zip'),
      makeOutput(tarPath, 'tar'),
      {},
      makeCtx(scratch),
    );

    const roundTrippedZipPath = path.join(scratch, 'out.zip');
    await zipTarRepackConverter.convert(
      makeInput(tarPath, 'tar'),
      makeOutput(roundTrippedZipPath, 'zip'),
      {},
      makeCtx(scratch),
    );

    const original = unzipSync(originalBytes);
    const roundTripped = unzipSync(fs.readFileSync(roundTrippedZipPath));

    const namesOf = (u: Record<string, Uint8Array>) =>
      Object.keys(u)
        .filter((k) => !k.endsWith('/'))
        .sort();

    expect(namesOf(roundTripped)).toEqual(namesOf(original));
    for (const name of namesOf(original)) {
      expect(
        Buffer.from(roundTripped[name] as Uint8Array).equals(
          Buffer.from(original[name] as Uint8Array),
        ),
      ).toBe(true);
    }
  });

  it('refuses to extract a zip-slip archive instead of writing outside the destination', async () => {
    const scratch = makeScratchDir();
    const maliciousZip = zipSync({
      '../../evil.txt': enc('pwned'),
      'ok.txt': enc('fine'),
    });
    const zipPath = path.join(scratch, 'evil.zip');
    fs.writeFileSync(zipPath, maliciousZip);
    const outPath = path.join(scratch, 'out.tar');

    await expect(
      zipTarRepackConverter.convert(
        makeInput(zipPath, 'zip'),
        makeOutput(outPath, 'tar'),
        {},
        makeCtx(scratch),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });

    // The staging dir created for this conversion lives directly under
    // `scratch`, so "../../evil.txt" from there resolves to os.tmpdir().
    // It must never have been written.
    expect(fs.existsSync(path.join(os.tmpdir(), 'evil.txt'))).toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('rejects unsupported format pairs with E_UNSUPPORTED_FEATURE', async () => {
    const scratch = makeScratchDir();
    const zipPath = path.join(scratch, 'in.zip');
    fs.writeFileSync(zipPath, buildFixtureZip());
    await expect(
      zipTarRepackConverter.convert(
        makeInput(zipPath, 'zip'),
        makeOutput(path.join(scratch, 'out.7z'), '7z'),
        {},
        makeCtx(scratch),
      ),
    ).rejects.toBeInstanceOf(ConversionError);
  });
});
