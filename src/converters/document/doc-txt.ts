/**
 * `doc -> txt` via `word-extractor`.
 *
 * `doc` (legacy binary Word 97-2003) is `readOnly` in the format registry, so
 * this converter's `outputs` is `['txt']`, never `['html']` or `['doc']`.
 * This is explicitly text-fidelity only: no formatting, images, tables, or
 * layout survive. `word-extractor` also exposes footnotes/endnotes/headers/
 * footers separately; appending them keeps the extracted text close to what
 * a reader would actually see, without attempting any layout reconstruction.
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
import WordExtractor from 'word-extractor';

export const docToText: Converter = {
  id: 'doc:doc-to-txt',
  name: 'Legacy Word Document to Text (word-extractor)',
  engine: 'pure-js',
  inputs: ['doc'],
  outputs: ['txt'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    // Explicitly text-only: formatting, images, and layout are gone.
    return { retention: 0.4, effort: 2, structure: 0 };
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
    const extractor = new WordExtractor();

    let doc: Awaited<ReturnType<WordExtractor['extract']>>;
    try {
      doc = await extractor.extract(buffer);
    } catch (err: unknown) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This Word 97-2003 document could not be read. It may be corrupted.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const sections = [doc.getBody()];
    const footnotes = doc.getFootnotes().trim();
    if (footnotes.length > 0) sections.push(`\n---\nFootnotes:\n${footnotes}`);
    const endnotes = doc.getEndnotes().trim();
    if (endnotes.length > 0) sections.push(`\n---\nEndnotes:\n${endnotes}`);

    const text = `${sections.join('\n').trimEnd()}\n`;
    await writeFile(output.path, text, 'utf8');

    ctx.onProgress({ ratio: 1 });

    return {
      bytes: Buffer.byteLength(text, 'utf8'),
      warnings: [
        'Converted to plain text only — formatting, images, and layout were not preserved.',
      ],
    };
  },
};
