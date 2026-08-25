import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { cabIsoToZipConverter } from './cab-iso-to-zip';
import { sevenAdd, sevenRename, sevenZipAvailability } from './seven-zip';
import { makeCtx, makeInput, makeOutput, makeScratchDir } from './test-support';

let has7za = false;

beforeAll(async () => {
  has7za = (await sevenZipAvailability()).available;
});

// Genuine .cab/.iso bytes can't be synthesized here (no encoder is
// available offline), so these tests exercise the extraction plumbing —
// zip-slip validation, extractFull, re-zip — against a real archive that
// `7za` auto-detects by content signature, independent of the extension we
// hand it as `input.format`. The mechanism (`sevenList` -> `assertAllSafe`
// -> `sevenExtractFull` -> re-zip) is identical for real cab/iso input.

describe('archive:cab-iso-to-zip', () => {
  it('supports cab/iso -> zip only', () => {
    const s = cabIsoToZipConverter.supports;
    if (!s) throw new Error('supports() missing');
    expect(s('cab', 'zip')).toBe(true);
    expect(s('iso', 'zip')).toBe(true);
    expect(s('cab', 'tar')).toBe(false);
    expect(s('zip', 'zip')).toBe(false);
  });

  it('extracts an archive and re-zips its contents', async () => {
    if (!has7za) return;
    const scratch = makeScratchDir();
    const srcDir = path.join(scratch, 'src');
    fs.mkdirSync(path.join(srcDir, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(srcDir, 'dir', 'b.txt'), 'world');

    const archivePath = path.join(scratch, 'in.cab');
    await sevenAdd(
      archivePath,
      [path.join(srcDir, 'a.txt'), path.join(srcDir, 'dir')],
      '7z',
    );

    const outZipPath = path.join(scratch, 'out.zip');
    await cabIsoToZipConverter.convert(
      makeInput(archivePath, 'cab'),
      makeOutput(outZipPath, 'zip'),
      {},
      makeCtx(scratch),
    );

    const unzipped = unzipSync(fs.readFileSync(outZipPath));
    expect(Buffer.from(unzipped['a.txt'] as Uint8Array).toString('utf8')).toBe('hello');
    expect(Buffer.from(unzipped['dir/b.txt'] as Uint8Array).toString('utf8')).toBe(
      'world',
    );
  });

  it('refuses to extract an archive containing a zip-slip path', async () => {
    if (!has7za) return;
    const scratch = makeScratchDir();
    const srcDir = path.join(scratch, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'ok.txt'), 'pwned');
    const archivePath = path.join(scratch, 'evil.iso');
    await sevenAdd(archivePath, path.join(srcDir, 'ok.txt'), '7z');
    await sevenRename(archivePath, [['ok.txt', '../../evil.txt']]);

    const outZipPath = path.join(scratch, 'out.zip');
    await expect(
      cabIsoToZipConverter.convert(
        makeInput(archivePath, 'iso'),
        makeOutput(outZipPath, 'zip'),
        {},
        makeCtx(scratch),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });

    expect(fs.existsSync(path.join(os.tmpdir(), 'evil.txt'))).toBe(false);
    expect(fs.existsSync(outZipPath)).toBe(false);
  });
});
