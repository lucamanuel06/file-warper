/**
 * `md -> html` via `marked` (GFM enabled).
 *
 * `marked` ships ESM-only (no `require` export condition), so it must be
 * loaded with a dynamic `import()` even from this CJS-compiled module.
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

function wrapHtml(body: string): string {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

export const mdToHtml: Converter = {
  id: 'doc:md-to-html',
  name: 'Markdown to HTML (marked)',
  engine: 'pure-js',
  inputs: ['md'],
  outputs: ['html'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    // Markdown -> HTML is close to lossless: every GFM construct has a
    // direct, semantic HTML equivalent.
    return { retention: 0.98, effort: 1, structure: 0.9 };
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
    if (ctx.signal.aborted) {
      throw new ConversionError({
        code: 'E_CANCELLED',
        userMessage: 'Conversion was cancelled.',
      });
    }

    const buffer = await input.readBuffer();
    const source = buffer.toString('utf8');

    const { marked } = await import('marked');

    let body: string;
    try {
      body = await marked.parse(source, { gfm: true });
    } catch (err: unknown) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This Markdown file could not be parsed.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    ctx.onProgress({ ratio: 0.8, message: 'Rendering HTML' });

    const html = wrapHtml(body);
    await writeFile(output.path, html, 'utf8');

    ctx.onProgress({ ratio: 1 });

    return { bytes: Buffer.byteLength(html, 'utf8') };
  },
};
