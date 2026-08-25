/**
 * `txt -> html`. `html` is the document hub, so this single edge is what
 * makes `txt -> pdf/md/docx/epub` (and everything else reachable through
 * html) fall out of the graph for free — without it, plain text is only
 * ever a conversion OUTPUT in this codebase, never an input.
 *
 * Legacy text files are often not UTF-8 (CP1252 from old Windows exports,
 * Shift-JIS from Japanese sources, ...); decoding them as UTF-8 regardless
 * produces mojibake. Detect the encoding with `chardet` and decode with
 * `iconv-lite` before doing anything else.
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
import chardet from 'chardet';
import iconv from 'iconv-lite';

/** Decode a buffer of unknown text encoding to a JS string. */
function decodeText(buffer: Buffer): string {
  const detected = chardet.detect(buffer);
  const encoding = detected && iconv.encodingExists(detected) ? detected : 'utf8';
  return iconv.decode(buffer, encoding);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Blank-line-separated blocks become `<p>`; a single newline inside a block
 * becomes `<br>`. This is the only structure plain text has to preserve.
 */
function textToBodyHtml(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  return blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${escapeHtml(block).split('\n').join('<br>\n')}</p>`)
    .join('\n');
}

function wrapHtml(bodyHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: normal;
    line-height: 1.5;
    max-width: 40em;
    margin: 2em auto;
  }
  p { margin: 0 0 1em; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

export const txtToHtml: Converter = {
  id: 'doc:txt-to-html',
  name: 'Plain Text to HTML',
  engine: 'pure-js',
  residency: 'worker',

  inputs: ['txt'],
  outputs: ['html'],

  cost(): EdgeCost {
    // Every byte of the text survives; plain text has essentially no
    // structure (headings, tables, styling) to lose in the first place.
    return { retention: 1.0, effort: 1, structure: 0.9 };
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

    ctx.onProgress({ ratio: 0, message: 'Reading text file' });

    let buffer: Buffer;
    try {
      buffer = await input.readBuffer();
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: `Could not read "${input.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.4, message: 'Detecting encoding' });

    const text = decodeText(buffer);
    const html = wrapHtml(textToBodyHtml(text));

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
