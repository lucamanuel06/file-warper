import fs from 'node:fs';
import path from 'node:path';
import { ConversionError } from '@core/types';
import { describe, expect, it } from 'vitest';
import { rarToZipConverter } from './rar-to-zip';
import { makeCtx, makeInput, makeOutput, makeScratchDir } from './test-support';

// `node-unrar-js` is extraction-only and there is no offline RAR encoder
// available in this environment, so a genuine RAR round-trip fixture can't
// be built here (unlike zip/tar/7z, which we can synthesize with fflate/
// tar/7za). These tests cover wiring and the corrupt-input path; the
// zip-slip guard for this converter is the same `assertAllSafe` helper
// covered directly in `safe-path.test.ts` and exercised end-to-end for
// zip/7z/cab/iso elsewhere in this directory.

describe('archive:rar-to-zip', () => {
  it('supports rar -> zip only', () => {
    const s = rarToZipConverter.supports;
    if (!s) throw new Error('supports() missing');
    expect(s('rar', 'zip')).toBe(true);
    expect(s('rar', 'tar')).toBe(false);
    expect(s('zip', 'zip')).toBe(false);
  });

  it('is always available (self-contained WASM, no external binary)', async () => {
    await expect(rarToZipConverter.availability()).resolves.toEqual({ available: true });
  });

  it('rejects a corrupt/non-RAR input with E_CORRUPT_INPUT', async () => {
    const scratch = makeScratchDir();
    const fakeRarPath = path.join(scratch, 'not-a.rar');
    fs.writeFileSync(fakeRarPath, Buffer.from('this is not a rar archive'));

    await expect(
      rarToZipConverter.convert(
        makeInput(fakeRarPath, 'rar'),
        makeOutput(path.join(scratch, 'out.zip'), 'zip'),
        {},
        makeCtx(scratch),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });

  it('rejects unsupported format pairs', async () => {
    const scratch = makeScratchDir();
    const p = path.join(scratch, 'x.rar');
    fs.writeFileSync(p, 'x');
    await expect(
      rarToZipConverter.convert(
        makeInput(p, 'rar'),
        makeOutput(path.join(scratch, 'out.tar'), 'tar'),
        {},
        makeCtx(scratch),
      ),
    ).rejects.toBeInstanceOf(ConversionError);
  });
});
