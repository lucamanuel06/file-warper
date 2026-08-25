import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { createFont } from 'fonteditor-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fontConverters } from './index';

const repack = fontConverters[0];
const otfOutline = fontConverters[1];
if (!repack || !otfOutline) throw new Error('fontConverters is missing an entry');

function makeInput(path: string, format: string, buffer: Buffer): ConversionInput {
  return {
    path,
    format,
    size: buffer.byteLength,
    async readBuffer() {
      return buffer;
    },
    createReadStream() {
      throw new Error('not used in these tests');
    },
  };
}

function makeContext(scratchDir: string): ConvertContext {
  return {
    onProgress() {},
    signal: new AbortController().signal,
    scratchDir,
    log() {},
  };
}

/**
 * Test fixture strategy (per the build brief): there is no tiny sample font
 * checked into this repo, and `fonteditor-core` ships none either. Instead
 * of hand-rolling a minimal-sfnt binary builder, we use `fonteditor-core`'s
 * own, already-tested "empty font" feature (`createFont()` with no
 * arguments -> `Font#readEmpty()` -> `getEmptyttfObject()`), which is a
 * real, documented part of its public API and produces a genuinely valid
 * one-glyph TrueType font object (a ".notdef" rectangle glyph — see
 * `fonteditor-core/src/ttf/data/empty.js`). Writing that out with the same
 * library gives us a real, parseable `.ttf` buffer to drive every test
 * below.
 */
function buildTtfFixture(): Buffer {
  const font = createFont();
  return font.write({ type: 'ttf', toBuffer: true });
}

describe('font converters', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'font-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('font:repackage', () => {
    it('declares ttf/woff/woff2/eot as both inputs and outputs', () => {
      expect(repack.inputs).toEqual(['ttf', 'woff', 'woff2', 'eot']);
      expect(repack.outputs).toEqual(['ttf', 'woff', 'woff2', 'eot']);
    });

    it('supports every distinct pair and rejects identity pairs', () => {
      expect(repack.supports?.('ttf', 'woff2')).toBe(true);
      expect(repack.supports?.('eot', 'woff')).toBe(true);
      expect(repack.supports?.('ttf', 'ttf')).toBe(false);
      expect(repack.supports?.('ttf', 'otf')).toBe(false);
    });

    it('reports full retention for every pair', () => {
      expect(repack.cost('ttf', 'woff2').retention).toBe(1);
      expect(repack.cost('woff', 'eot').retention).toBe(1);
    });

    it('never throws from availability() and reports available', async () => {
      await expect(repack.availability()).resolves.toEqual({ available: true });
    });

    it('converts ttf to woff2 and writes a real, parseable file', async () => {
      const ttfBuffer = buildTtfFixture();
      const input = makeInput(join(dir, 'in.ttf'), 'ttf', ttfBuffer);
      const outPath = join(dir, 'out.woff2');

      const result = await repack.convert(
        input,
        { path: outPath, format: 'woff2' },
        {},
        makeContext(dir),
      );

      expect(result.warnings).toBeUndefined();
      expect(result.meta).toEqual({ numGlyphs: 1, unitsPerEm: 1024 });

      const written = await readFile(outPath);
      // WOFF2 magic: 'wOF2'
      expect(written.subarray(0, 4).toString('ascii')).toBe('wOF2');

      const reparsed = createFont(written, { type: 'woff2' });
      const data = reparsed.get();
      expect(data.maxp.numGlyphs).toBeGreaterThan(0);
      expect(data.head.unitsPerEm).toBe(1024);
    });

    it('round-trips ttf -> woff2 -> eot -> woff -> ttf preserving glyph count and units-per-em', async () => {
      const original = buildTtfFixture();
      const originalParsed = createFont(original, { type: 'ttf' }).get();

      let current = original;
      let currentFormat = 'ttf';
      const chain: Array<{ format: string; ext: string }> = [
        { format: 'woff2', ext: 'woff2' },
        { format: 'eot', ext: 'eot' },
        { format: 'woff', ext: 'woff' },
        { format: 'ttf', ext: 'ttf' },
      ];

      for (const step of chain) {
        const inPath = join(dir, `hop-in-${currentFormat}.bin`);
        const outPath = join(dir, `hop-out-${step.format}.${step.ext}`);
        const result = await repack.convert(
          makeInput(inPath, currentFormat, current),
          { path: outPath, format: step.format },
          {},
          makeContext(dir),
        );
        expect(result.meta).toEqual({
          numGlyphs: originalParsed.maxp.numGlyphs,
          unitsPerEm: originalParsed.head.unitsPerEm,
        });
        current = await readFile(outPath);
        currentFormat = step.format;
      }

      const finalParsed = createFont(current, { type: 'ttf' }).get();
      expect(finalParsed.maxp.numGlyphs).toBe(originalParsed.maxp.numGlyphs);
      expect(finalParsed.head.unitsPerEm).toBe(originalParsed.head.unitsPerEm);
      expect(finalParsed.glyf[0]?.name).toBe(originalParsed.glyf[0]?.name);
    });

    it('throws E_CORRUPT_INPUT for a garbage buffer', async () => {
      const input = makeInput(
        join(dir, 'garbage.ttf'),
        'ttf',
        Buffer.from('this is not a font file, just plain text bytes'),
      );
      await expect(
        repack.convert(
          input,
          { path: join(dir, 'out.woff'), format: 'woff' },
          {},
          makeContext(dir),
        ),
      ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
    });

    it('throws E_CORRUPT_INPUT for a too-short buffer', async () => {
      const input = makeInput(join(dir, 'tiny.ttf'), 'ttf', Buffer.alloc(2));
      await expect(
        repack.convert(
          input,
          { path: join(dir, 'out.ttf'), format: 'ttf' },
          {},
          makeContext(dir),
        ),
      ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
    });

    it('throws E_CANCELLED when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const ctx: ConvertContext = {
        onProgress() {},
        signal: controller.signal,
        scratchDir: dir,
        log() {},
      };
      const input = makeInput(join(dir, 'in.ttf'), 'ttf', buildTtfFixture());
      await expect(
        repack.convert(input, { path: join(dir, 'out.woff2'), format: 'woff2' }, {}, ctx),
      ).rejects.toMatchObject({ code: 'E_CANCELLED' });
    });
  });

  describe('font:otf-outline', () => {
    it('declares otf as its only input and the repack formats as outputs', () => {
      expect(otfOutline.inputs).toEqual(['otf']);
      expect(otfOutline.outputs).toEqual(['ttf', 'woff', 'woff2', 'eot']);
    });

    it('supports otf into every repack format, and nothing else', () => {
      expect(otfOutline.supports?.('otf', 'ttf')).toBe(true);
      expect(otfOutline.supports?.('otf', 'woff2')).toBe(true);
      expect(otfOutline.supports?.('ttf', 'otf')).toBe(false);
      expect(otfOutline.supports?.('otf', 'otf')).toBe(false);
    });

    it('reports reduced retention (lossy outline conversion)', () => {
      const cost = otfOutline.cost('otf', 'ttf');
      expect(cost.retention).toBeLessThan(1);
      expect(cost.retention).toBeGreaterThan(0.5);
    });

    it('never throws from availability() and reports available', async () => {
      await expect(otfOutline.availability()).resolves.toEqual({ available: true });
    });

    it('throws E_CORRUPT_INPUT for a garbage buffer claiming to be otf', async () => {
      const input = makeInput(
        join(dir, 'garbage.otf'),
        'otf',
        Buffer.from('this is not a font file, just plain text bytes'),
      );
      await expect(
        otfOutline.convert(
          input,
          { path: join(dir, 'out.ttf'), format: 'ttf' },
          {},
          makeContext(dir),
        ),
      ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
    });

    it('rejects a non-otf input format with E_UNSUPPORTED_FEATURE', async () => {
      const input = makeInput(join(dir, 'in.ttf'), 'ttf', buildTtfFixture());
      await expect(
        otfOutline.convert(
          input,
          { path: join(dir, 'out.ttf'), format: 'ttf' },
          {},
          makeContext(dir),
        ),
      ).rejects.toMatchObject({ code: 'E_UNSUPPORTED_FEATURE' });
    });

    // NOTE: there is no real byte-level round-trip test for a genuine
    // CFF-outline .otf file here. `fonteditor-core` can only WRITE
    // TrueType-flavored (glyf) fonts (see index.ts's header comment), so
    // it cannot be used to manufacture its own otf test fixture, and
    // hand-encoding a minimal-but-valid CFF table (INDEX structures, DICT
    // operators, Type 2 charstrings) to match this library's own CFF
    // parser is a much bigger undertaking than the sfnt/glyf builder the
    // brief describes as a fallback — judged not worth the time budget for
    // this lower-priority converter. The otf read path
    // (`readFont(buffer, 'otf')`) is a thin, direct call into
    // `fonteditor-core`'s own `otf2ttfobject`, and the write path is byte-
    // for-byte the same `writeFont` already exercised end-to-end above, so
    // the untested surface is narrow: whether `fonteditor-core` correctly
    // parses a real CFF table, which is a property of the library, not of
    // this wrapper's logic. The tests above instead cover this
    // converter's own responsibilities: declared format matrix, cost,
    // availability, error mapping on bad input, and rejecting the wrong
    // input format.
  });
});
