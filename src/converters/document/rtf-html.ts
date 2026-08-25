/**
 * `rtf -> html` via a small hand-rolled tokenizer.
 *
 * This is NOT a complete RTF implementation — RTF's real grammar (destination
 * groups, character-set overrides, field codes, revision marks, embedded
 * objects) is large. This covers the 95% case: a plain document using
 * paragraphs and basic character formatting (bold/italic/underline).
 *
 * Explicitly out of scope (dropped silently, content preserved as plain
 * text where possible): tables, embedded images/objects, fonts/colors,
 * footnotes, fields (hyperlinks, TOC), revision tracking, and any RTF
 * version-specific extensions. Unknown control words and their groups
 * (`\fonttbl`, `\colortbl`, `\stylesheet`, `\*\...` destinations) are
 * stripped so their raw table data never leaks into the visible text.
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Destination control words whose entire group's text must never surface. */
const IGNORED_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'stylesheeet',
  'info',
  'generator',
  'pict',
  'object',
  'objdata',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'xmlnstbl',
  'mmathPr',
  'nonshppict',
  'shpinst',
  'shprslt',
  'field',
  'fldinst',
  'header',
  'footer',
  'headerf',
  'footerf',
  'footnote',
  'datafield',
  'bkmkstart',
  'bkmkend',
  'atnid',
  'atnauthor',
  'atndate',
]);

interface GroupState {
  /** Text inside this group (and any never-ignored nested groups) is dropped. */
  ignored: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

interface ParseResult {
  html: string;
  usedUnknownControlWords: boolean;
}

/**
 * Tokenizes and renders an RTF document body into HTML. Paragraphs (`\par`,
 * `\pard`) become `<p>`, and `\b`/`\i`/`\ul` toggle inline `<strong>`/`<em>`/
 * `<u>` spans. Every other control word is consumed and discarded; the
 * `{`/`}` group it's found in is tracked so destination groups (font tables,
 * color tables, etc.) never contribute their raw table text to the output.
 */
function parseRtf(source: string): ParseResult {
  let i = 0;
  const n = source.length;
  const stack: GroupState[] = [
    { ignored: false, bold: false, italic: false, underline: false },
  ];
  let usedUnknownControlWords = false;

  const paragraphs: string[] = [];
  let currentInline: {
    text: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
  }[] = [];
  let pendingText = '';
  let pendingBold = false;
  let pendingItalic = false;
  let pendingUnderline = false;

  function flushPendingRun(): void {
    if (pendingText.length === 0) return;
    currentInline.push({
      text: pendingText,
      bold: pendingBold,
      italic: pendingItalic,
      underline: pendingUnderline,
    });
    pendingText = '';
  }

  function flushParagraph(): void {
    flushPendingRun();
    if (currentInline.length === 0) return;
    const html = currentInline
      .map((run) => {
        let t = escapeHtml(run.text);
        if (run.underline) t = `<u>${t}</u>`;
        if (run.italic) t = `<em>${t}</em>`;
        if (run.bold) t = `<strong>${t}</strong>`;
        return t;
      })
      .join('');
    if (html.trim().length > 0) {
      paragraphs.push(`<p>${html}</p>`);
    }
    currentInline = [];
  }

  function top(): GroupState {
    const t = stack[stack.length - 1];
    if (!t) throw new Error('RTF group stack underflow');
    return t;
  }

  function appendText(text: string): void {
    if (top().ignored || text.length === 0) return;
    const state = top();
    if (
      state.bold !== pendingBold ||
      state.italic !== pendingItalic ||
      state.underline !== pendingUnderline
    ) {
      flushPendingRun();
      pendingBold = state.bold;
      pendingItalic = state.italic;
      pendingUnderline = state.underline;
    }
    pendingText += text;
  }

  while (i < n) {
    const ch = source[i];

    if (ch === '{') {
      flushPendingRun();
      const parent = top();
      stack.push({ ...parent });
      i++;
      continue;
    }

    if (ch === '}') {
      flushPendingRun();
      stack.pop();
      if (stack.length === 0)
        stack.push({ ignored: false, bold: false, italic: false, underline: false });
      i++;
      continue;
    }

    if (ch === '\\') {
      i++;
      if (i >= n) break;
      const next = source[i];

      // Escaped literal characters.
      if (next === '\\' || next === '{' || next === '}') {
        appendText(next);
        i++;
        continue;
      }

      // Newline/CR in source treated as insignificant whitespace (real
      // paragraph breaks come from \par, not raw newlines).
      if (next === '\n' || next === '\r') {
        i++;
        continue;
      }

      // Hex-escaped byte, e.g. \'e9 (Windows-1252 in most real-world docs;
      // treated as Latin-1 which is correct for the ASCII/Latin range that
      // covers the overwhelming majority of real documents).
      if (next === "'") {
        const hex = source.slice(i + 1, i + 3);
        i += 3;
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) appendText(String.fromCharCode(code));
        continue;
      }

      // Control word: letters, optional signed numeric parameter, optional
      // single trailing space (consumed as a delimiter, not content).
      const wordMatch = /^([a-zA-Z]+)(-?\d+)?/.exec(source.slice(i));
      if (wordMatch) {
        const word = wordMatch[1] ?? '';
        i += wordMatch[0].length;
        if (source[i] === ' ') i++;

        switch (word) {
          case 'par':
          case 'pard':
            flushParagraph();
            break;
          case 'line':
            appendText('\n');
            break;
          case 'tab':
            appendText('\t');
            break;
          case 'b':
            top().bold = wordMatch[2] !== '0';
            break;
          case 'i':
            top().italic = wordMatch[2] !== '0';
            break;
          case 'ul':
            top().underline = wordMatch[2] !== '0';
            break;
          case 'ulnone':
            top().underline = false;
            break;
          case 'emdash':
            appendText('—');
            break;
          case 'endash':
            appendText('–');
            break;
          case 'lquote':
            appendText('‘');
            break;
          case 'rquote':
            appendText('’');
            break;
          case 'ldblquote':
            appendText('“');
            break;
          case 'rdblquote':
            appendText('”');
            break;
          case 'bullet':
            appendText('•');
            break;
          default:
            if (IGNORED_DESTINATIONS.has(word)) {
              top().ignored = true;
            } else {
              usedUnknownControlWords = true;
            }
            break;
        }
        continue;
      }

      // `\*` marks the next destination as "ignorable if unknown" — treat
      // conservatively as ignored so unrecognized extension data never leaks.
      if (next === '*') {
        top().ignored = true;
        i++;
        continue;
      }

      // Unrecognized escape: skip the one character.
      i++;
      continue;
    }

    // Plain character.
    appendText(ch ?? '');
    i++;
  }

  flushParagraph();

  return { html: paragraphs.join('\n'), usedUnknownControlWords };
}

function wrapHtml(body: string): string {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

export const rtfToHtml: Converter = {
  id: 'doc:rtf-to-html',
  name: 'RTF to HTML (hand-rolled tokenizer)',
  engine: 'pure-js',
  inputs: ['rtf'],
  outputs: ['html'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    // Honest about scope: paragraphs and basic character formatting survive;
    // tables, images, fonts/colors, fields and footnotes do not.
    return { retention: 0.65, effort: 2, structure: 0.4 };
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
    // RTF control structure is ASCII; non-ASCII text travels either as
    // \'hh hex escapes or \uNNNN Unicode escapes, both readable from a
    // Latin-1 decode of the raw bytes.
    const source = buffer.toString('latin1');

    if (!source.trimStart().startsWith('{\\rtf')) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This does not look like a valid RTF file.',
      });
    }

    let parsed: ParseResult;
    try {
      parsed = parseRtf(source);
    } catch (err: unknown) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This RTF file could not be parsed.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const html = wrapHtml(parsed.html);
    await writeFile(output.path, html, 'utf8');

    ctx.onProgress({ ratio: 1 });

    const warnings = [
      'RTF conversion covers paragraphs and basic bold/italic/underline formatting only. Tables, images, fonts, colors, and fields are not preserved.',
    ];
    if (parsed.usedUnknownControlWords) {
      warnings.push(
        'Some formatting in this document used RTF features that are not supported and were ignored.',
      );
    }

    return { bytes: Buffer.byteLength(html, 'utf8'), warnings };
  },
};
