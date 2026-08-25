/**
 * Font converters, backed entirely by `fonteditor-core` 2.6.3.
 *
 * Format matrix (see `docs/spec-engines.md` / this converter's build brief
 * for the full rationale):
 *
 *  - ttf, woff, woff2, eot: `fonteditor-core` can both read and write all
 *    four. They all wrap the same glyf-outline table data, so hopping
 *    between them is pure container repackaging — lossless, no warnings.
 *    Handled by `font:repackage` below.
 *
 *  - otf: `fonteditor-core` can only READ otf (its own README: "otf (only
 *    read and convert to ttf)"), and its `Font#write` switch statement
 *    (`fonteditor-core/src/ttf/font.js`) has no `'otf'` case at all — it
 *    throws `not support font type otf` if asked. So `otf` is never a
 *    write target here, which also means we never attempt the reverse
 *    direction (ttf/woff/woff2/eot -> otf, i.e. glyf quadratic curves back
 *    to CFF cubic curves): the library exposes no path for it, so that
 *    edge is simply not declared rather than faked. Reading an otf and
 *    writing ttf/woff/woff2/eot converts its CFF cubic outlines to
 *    TrueType quadratic outlines and drops hinting — lossy, so
 *    `font:otf-outline` reports reduced retention and a warning.
 */
import { writeFile } from 'node:fs/promises';
import type {
  ConversionInput,
  ConversionOutput,
  ConvertContext,
  Converter,
  ConverterOptions,
  ConvertResult,
  EdgeCost,
  FormatId,
} from '@core/types';
import { ConversionError } from '@core/types';
import type { RepackFormat } from './font-io';
import { isRepackFormat, REPACK_FORMATS, readFont, writeFont } from './font-io';

function cancelled(): ConversionError {
  return new ConversionError({
    code: 'E_CANCELLED',
    userMessage: 'The conversion was cancelled.',
    retryable: false,
  });
}

async function writeOutputFile(path: string, buffer: Buffer): Promise<void> {
  try {
    await writeFile(path, buffer);
  } catch (cause) {
    throw new ConversionError({
      code: 'E_PERMISSION',
      userMessage: `Could not write the converted font to "${path}".`,
      detail: cause instanceof Error ? cause.message : String(cause),
      retryable: true,
      cause,
    });
  }
}

export const fontConverters: Converter[] = [
  {
    id: 'font:repackage',
    name: 'Font Container Repackager',
    engine: 'pure-js',
    residency: 'worker',
    inputs: REPACK_FORMATS,
    outputs: REPACK_FORMATS,

    supports(from: FormatId, to: FormatId): boolean {
      return from !== to && isRepackFormat(from) && isRepackFormat(to);
    },

    cost(_from: FormatId, _to: FormatId): EdgeCost {
      // Same glyph data, different container — lossless in every direction.
      return { retention: 1, effort: 1, structure: 1 };
    },

    async availability() {
      // Pure JS/WASM, no external binary. The woff2 WASM module loads
      // lazily on first woff2 read/write (see font-io.ts); a failure there
      // surfaces as an E_ENGINE ConversionError from convert() rather than
      // here, since actually probing it would mean eagerly paying the
      // WASM load cost on every availability check.
      return { available: true };
    },

    async convert(
      input: ConversionInput,
      output: ConversionOutput,
      _options: ConverterOptions,
      ctx: ConvertContext,
    ): Promise<ConvertResult> {
      const from = input.format;
      const to = output.format;

      if (!isRepackFormat(from) || !isRepackFormat(to)) {
        throw new ConversionError({
          code: 'E_UNSUPPORTED_FEATURE',
          userMessage: `Converting "${from}" to "${to}" is not a font repackaging this converter can do.`,
          retryable: false,
        });
      }

      ctx.onProgress({ ratio: 0, message: `Reading ${from.toUpperCase()} font` });
      const buffer = await input.readBuffer();

      if (ctx.signal.aborted) throw cancelled();

      const font = await readFont(buffer, from);

      if (ctx.signal.aborted) throw cancelled();
      ctx.onProgress({ ratio: 0.5, message: `Writing ${to.toUpperCase()} font` });

      const outBuffer = await writeFont(font, to);

      if (ctx.signal.aborted) throw cancelled();
      await writeOutputFile(output.path, outBuffer);

      ctx.onProgress({ ratio: 1, message: 'Done' });

      const data = font.get();
      return {
        bytes: outBuffer.length,
        meta: { numGlyphs: data.maxp.numGlyphs, unitsPerEm: data.head.unitsPerEm },
      };
    },
  },
  {
    id: 'font:otf-outline',
    name: 'OTF to TrueType Outline Converter',
    engine: 'pure-js',
    residency: 'worker',
    inputs: ['otf'],
    outputs: REPACK_FORMATS,

    supports(from: FormatId, to: FormatId): boolean {
      return from === 'otf' && isRepackFormat(to);
    },

    cost(_from: FormatId, _to: FormatId): EdgeCost {
      // CFF cubic Bezier outlines are re-fit to TrueType quadratic
      // outlines and hinting is dropped — a real but modest quality loss.
      return { retention: 0.88, effort: 3, structure: 0.9 };
    },

    async availability() {
      return { available: true };
    },

    async convert(
      input: ConversionInput,
      output: ConversionOutput,
      _options: ConverterOptions,
      ctx: ConvertContext,
    ): Promise<ConvertResult> {
      const to = output.format;

      if (input.format !== 'otf') {
        throw new ConversionError({
          code: 'E_UNSUPPORTED_FEATURE',
          userMessage: 'This converter only reads OpenType (.otf) fonts.',
          retryable: false,
        });
      }
      if (!isRepackFormat(to)) {
        throw new ConversionError({
          code: 'E_UNSUPPORTED_FEATURE',
          userMessage: `"${to}" is not a font format this converter can write.`,
          retryable: false,
        });
      }
      const target: RepackFormat = to;

      ctx.onProgress({ ratio: 0, message: 'Reading OTF font' });
      const buffer = await input.readBuffer();

      if (ctx.signal.aborted) throw cancelled();

      const font = await readFont(buffer, 'otf');

      if (ctx.signal.aborted) throw cancelled();
      ctx.onProgress({
        ratio: 0.6,
        message: `Converting outlines to ${target.toUpperCase()}`,
      });

      const outBuffer = await writeFont(font, target);

      if (ctx.signal.aborted) throw cancelled();
      await writeOutputFile(output.path, outBuffer);

      ctx.onProgress({ ratio: 1, message: 'Done' });

      const data = font.get();
      return {
        bytes: outBuffer.length,
        warnings: ['Converted PostScript outlines to TrueType outlines (best effort).'],
        meta: { numGlyphs: data.maxp.numGlyphs, unitsPerEm: data.head.unitsPerEm },
      };
    },
  },
];
