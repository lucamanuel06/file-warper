/** `html -> txt` via `html-to-text`. Pure JS, no external binary. */

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
import { convert as convertHtmlToText } from 'html-to-text';

export const htmlToTxtConverter: Converter = {
  id: 'doc:html-to-txt',
  name: 'HTML to Plain Text',
  engine: 'pure-js',
  residency: 'worker',

  inputs: ['html'],
  outputs: ['txt'],

  cost(): EdgeCost {
    // All markup, styling, and layout is discarded — only the reading-order
    // text survives.
    return { retention: 0.45, effort: 2, structure: 0.1 };
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

    ctx.onProgress({ ratio: 0, message: 'Reading HTML' });

    let html: string;
    try {
      html = (await input.readBuffer()).toString('utf8');
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: `Could not read the HTML file "${input.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.5, message: 'Converting to plain text' });

    let text: string;
    try {
      text = convertHtmlToText(html, { wordwrap: 100 });
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This HTML file could not be parsed.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    try {
      await writeFile(output.path, text, 'utf8');
    } catch (cause) {
      throw new ConversionError({
        code: 'E_PERMISSION',
        userMessage: `Could not write the text file to "${output.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    return { bytes: Buffer.byteLength(text, 'utf8') };
  },
};
