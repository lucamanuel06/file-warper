/**
 * `docx -> html` via `mammoth`.
 *
 * Mammoth maps Word styles onto semantic HTML (headings, lists, tables,
 * emphasis) rather than pixel-perfect reproduction, and inlines images as
 * base64 `data:` URIs by default — exactly what the downstream `html -> pdf`
 * hop needs for a self-contained, offline-safe document.
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
import mammoth from 'mammoth';

function wrapHtml(body: string): string {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

export const docxToHtml: Converter = {
  id: 'doc:docx-to-html',
  name: 'Word Document to HTML (mammoth)',
  engine: 'pure-js',
  inputs: ['docx'],
  outputs: ['html'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    // Mammoth maps Word styles to semantic HTML — high but not perfect
    // fidelity: layout minutiae (exact pagination, precise spacing) is
    // intentionally not reproduced.
    return { retention: 0.9, effort: 2, structure: 0.85 };
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

    ctx.onProgress({ ratio: 0.1, message: 'Reading document' });

    let result: { value: string; messages: readonly { type: string; message: string }[] };
    try {
      result = await mammoth.convertToHtml({ path: input.path });
    } catch (err: unknown) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This Word document could not be read. It may be corrupted.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    ctx.onProgress({ ratio: 0.8, message: 'Writing HTML' });

    const html = wrapHtml(result.value);
    await writeFile(output.path, html, 'utf8');

    const warnings = result.messages
      .filter((m) => m.message)
      .map((m) => (m.type === 'error' ? `Error: ${m.message}` : m.message));

    ctx.onProgress({ ratio: 1 });

    return {
      bytes: Buffer.byteLength(html, 'utf8'),
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};
