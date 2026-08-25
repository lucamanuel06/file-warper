/**
 * Thin wrapper around `fonteditor-core`'s read/write API, shared by both
 * converters in this directory.
 *
 * `fonteditor-core` is CJS (`"type": "commonjs"` in its package.json, with a
 * `require` export condition) so it can be imported directly — unlike
 * `file-type`, no dynamic `import()` dance is needed here.
 *
 * woff2 is backed by a WASM build of Google's woff2 codec that must be
 * initialized once before the first woff2 read or write
 * (`fonteditor-core`'s README: "before read and write woff2, we should
 * first call woff2.init()"). `ensureWoff2Ready` does that lazily and caches
 * the in-flight promise so concurrent conversions share one init.
 */
import { ConversionError } from '@core/types';
// `fonteditor-core`'s `.d.ts` declares `FontEditor`/`TTF` as ambient
// namespaces re-exported from the module, so they're importable as types.
import type { FontEditor } from 'fonteditor-core';
import { createFont, woff2 } from 'fonteditor-core';

/**
 * Formats `fonteditor-core` can both read and write as plain container
 * repackaging (no outline transform): ttf, woff, woff2, eot all carry the
 * same glyf/CFF table data, just wrapped differently.
 */
export type RepackFormat = 'ttf' | 'woff' | 'woff2' | 'eot';

export const REPACK_FORMATS: readonly RepackFormat[] = ['ttf', 'woff', 'woff2', 'eot'];

const REPACK_FORMAT_SET: ReadonlySet<string> = new Set(REPACK_FORMATS);

export function isRepackFormat(format: string): format is RepackFormat {
  return REPACK_FORMAT_SET.has(format);
}

/** Formats this module can read. `otf` is read-only — see index.ts. */
export type ReadableFontFormat = RepackFormat | 'otf';

let woff2ReadyPromise: Promise<void> | null = null;

/**
 * Lazily initializes the woff2 WASM module and caches the result. If
 * `woff2.init()` ever rejects (e.g. the wasm binary can't be located), the
 * cached promise is cleared so a later call can retry instead of being
 * stuck on a permanently-rejected promise.
 */
async function ensureWoff2Ready(): Promise<void> {
  if (woff2.isInited()) {
    return;
  }
  if (!woff2ReadyPromise) {
    woff2ReadyPromise = woff2
      .init()
      .then(() => undefined)
      .catch((cause: unknown) => {
        woff2ReadyPromise = null;
        throw cause;
      });
  }
  await woff2ReadyPromise;
}

/**
 * Maps a `fonteditor-core` failure to a `ConversionError` with a
 * plain-English `userMessage`.
 *
 * `fonteditor-core`'s own parse errors are thrown as `Error` instances with
 * a numeric `.number` code (see its `ttf/error.js`); a buffer that's too
 * short to contain the tables it expects surfaces as a native `RangeError`
 * from the underlying `DataView`. Both mean "this isn't a valid font of the
 * type we were told it is" and map to `E_CORRUPT_INPUT`. Anything else is
 * treated as an engine-side failure.
 */
function toConversionError(cause: unknown, formatLabel: string): ConversionError {
  if (cause instanceof ConversionError) {
    return cause;
  }
  if (cause instanceof RangeError) {
    return new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: `This font file is too short or malformed to be a valid ${formatLabel.toUpperCase()} font.`,
      detail: cause.message,
      retryable: false,
      cause,
    });
  }
  const maybeNumbered = cause as { number?: unknown };
  if (cause instanceof Error && typeof maybeNumbered.number === 'number') {
    return new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: `This font file could not be read; it may be corrupted or not actually a ${formatLabel.toUpperCase()} font.`,
      detail: cause.message,
      retryable: false,
      cause,
    });
  }
  return new ConversionError({
    code: 'E_ENGINE',
    userMessage: `The font engine failed while processing this ${formatLabel.toUpperCase()} font.`,
    detail: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
    cause,
  });
}

/** Read a font buffer of the given format into a `fonteditor-core` `Font`. */
export async function readFont(
  buffer: Buffer,
  format: ReadableFontFormat,
): Promise<FontEditor.Font> {
  if (format === 'woff2') {
    await ensureWoff2Ready().catch((cause: unknown) => {
      throw toConversionError(cause, format);
    });
  }
  try {
    return createFont(buffer, { type: format, compound2simple: true });
  } catch (cause) {
    throw toConversionError(cause, format);
  }
}

/** Write a `fonteditor-core` `Font` out to a buffer in the given format. */
export async function writeFont(
  font: FontEditor.Font,
  format: RepackFormat,
): Promise<Buffer> {
  if (format === 'woff2') {
    await ensureWoff2Ready().catch((cause: unknown) => {
      throw toConversionError(cause, format);
    });
  }
  try {
    return font.write({ type: format, toBuffer: true });
  } catch (cause) {
    throw toConversionError(cause, format);
  }
}
