/** `html -> md` via `turndown` + the GFM plugin (tables, strikethrough, task lists). */

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
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

function buildTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  service.use(gfm);
  return service;
}

export const htmlToMdConverter: Converter = {
  id: 'doc:html-to-md',
  name: 'HTML to Markdown',
  engine: 'pure-js',
  residency: 'worker',

  inputs: ['html'],
  outputs: ['md'],

  cost(): EdgeCost {
    // Headings, lists, tables, emphasis, and links round-trip cleanly;
    // arbitrary layout/CSS does not.
    return { retention: 0.8, effort: 2, structure: 0.6 };
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

    ctx.onProgress({ ratio: 0.5, message: 'Converting to Markdown' });

    let markdown: string;
    try {
      markdown = buildTurndownService().turndown(html);
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This HTML file could not be parsed.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    const withTrailingNewline = markdown.endsWith('\n') ? markdown : `${markdown}\n`;

    try {
      await writeFile(output.path, withTrailingNewline, 'utf8');
    } catch (cause) {
      throw new ConversionError({
        code: 'E_PERMISSION',
        userMessage: `Could not write the Markdown file to "${output.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    return { bytes: Buffer.byteLength(withTrailingNewline, 'utf8') };
  },
};
