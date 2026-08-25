/**
 * `xhtml -> html`. XHTML is already valid HTML syntax (self-closing void
 * elements like `<br/>` parse fine under an HTML parser too), so this is a
 * near-passthrough: parse with linkedom — which also tolerates the `<?xml
 * ...?>` prologue XHTML documents typically start with — and re-serialize
 * as plain HTML. Cheap, and it unlocks the whole document hub for xhtml.
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
} from '@core/types';
import { ConversionError } from '@core/types';
import { parseHtml } from './dom';

export const xhtmlToHtml: Converter = {
  id: 'doc:xhtml-to-html',
  name: 'XHTML to HTML',
  engine: 'pure-js',
  residency: 'worker',

  inputs: ['xhtml'],
  outputs: ['html'],

  cost(): EdgeCost {
    // XHTML is a strict syntactic subset of HTML — nothing is lost.
    return { retention: 1.0, effort: 1, structure: 1.0 };
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
        userMessage: 'The conversion was cancelled.',
        retryable: false,
      });
    }

    ctx.onProgress({ ratio: 0, message: 'Reading XHTML' });

    let xhtml: string;
    try {
      xhtml = (await input.readBuffer()).toString('utf8');
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: `Could not read "${input.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.4, message: 'Parsing' });

    let html: string;
    try {
      const document = parseHtml(xhtml);
      html = document.toString();
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This XHTML file could not be parsed.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.8, message: 'Writing HTML' });

    try {
      await writeFile(output.path, html, 'utf8');
    } catch (cause) {
      throw new ConversionError({
        code: 'E_PERMISSION',
        userMessage: `Could not write the converted file to "${output.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    return { bytes: Buffer.byteLength(html, 'utf8') };
  },
};
