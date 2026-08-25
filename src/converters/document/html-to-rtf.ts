/**
 * `html -> rtf`. A hand-rolled RTF writer over the same supported-tag
 * subset as `html-to-docx.ts`'s mapper: `h1-h6 / p / strong(b) / em(i) / u
 * / s(strike) / ul / ol / li / table / a / code / blockquote / hr`.
 * Deliberately more basic than the docx writer: `<img>` is dropped (real
 * RTF image embedding needs `\pict` hex-encoded bytes, out of scope for a
 * "basic" writer), tables render as tab-separated cell text rather than
 * true `\trowd`/`\cell` row markup, and lists use a manual bullet/number
 * prefix rather than an RTF list table. Everything outside that tag
 * subset is dropped (its text still recurses through, just without
 * formatting) with a deduplicated warning per distinct dropped tag.
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
import { type HtmlElement, type HtmlNode, parseHtml } from './dom';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Recurse into children, emit nothing for the wrapper itself, never warn. */
const TRANSPARENT_TAGS = new Set([
  'html',
  'body',
  'div',
  'span',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
]);

/** Invisible document metadata — skip entirely, never warn. */
const SILENT_SKIP_TAGS = new Set([
  'head',
  'title',
  'meta',
  'link',
  'base',
  'script',
  'style',
]);

/** Inline formatting tags handled by `inline()`. */
const INLINE_TAGS = new Set([
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'strike',
  'del',
  'code',
  'a',
]);

const HEADING_HALF_POINTS: Record<string, number> = {
  h1: 56,
  h2: 48,
  h3: 40,
  h4: 36,
  h5: 32,
  h6: 28,
};

/**
 * `linkedom`'s `parseHTML` only synthesises a proper `html/head/body`
 * skeleton when the input already declares `<html>` — a bare fragment gets
 * its outermost element promoted to `documentElement` with no `body` at
 * all. Always parsing a full shell sidesteps that.
 */
function toFullHtmlDocument(html: string): string {
  return /<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return node.nodeType === ELEMENT_NODE;
}

function collapseWhitespace(text: string): string {
  return text.replace(/[\t\n\r ]+/g, ' ');
}

/** Escapes text for RTF: control chars, and non-ASCII as `\uN?` (UTF-16 code units). */
function escapeRtf(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const code = text.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (code === 10) out += '\\line ';
    else if (code === 13) continue;
    else if (code < 0x80) out += ch;
    else out += `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
  }
  return out;
}

/**
 * Walks a parsed HTML DOM and produces the RTF document body plus a list
 * of deduplicated "dropped element" warnings.
 */
class RtfMapper {
  private readonly out: string[] = [];
  private readonly droppedTags = new Set<string>();
  private droppedImage = false;

  get warnings(): string[] {
    const tagWarnings = [...this.droppedTags]
      .sort()
      .map((tag) => `Dropped unsupported element: <${tag}>`);
    return this.droppedImage
      ? [...tagWarnings, 'Images are not supported by the RTF writer and were dropped.']
      : tagWarnings;
  }

  mapBody(root: HtmlElement): string {
    this.mapBlockChildren(root, 0);
    return this.out.join('');
  }

  private mapBlockChildren(parent: HtmlNode, listDepth: number): void {
    for (const node of parent.childNodes) {
      if (node.nodeType === TEXT_NODE) {
        const text = collapseWhitespace(node.textContent ?? '').trim();
        if (text.length > 0) this.out.push(`{\\pard\\sa200 ${escapeRtf(text)}\\par}\n`);
      } else if (isElement(node)) {
        this.mapBlockElement(node, listDepth);
      }
    }
  }

  private mapBlockElement(el: HtmlElement, listDepth: number): void {
    const tag = el.tagName.toLowerCase();

    if (TRANSPARENT_TAGS.has(tag)) {
      this.mapBlockChildren(el, listDepth);
      return;
    }
    if (SILENT_SKIP_TAGS.has(tag)) return;

    if (tag === 'br') {
      this.out.push('\\line \n');
      return;
    }
    if (tag === 'hr') {
      this.out.push('{\\pard\\brdrb\\brdrs\\brdrw10\\brsp20\\par}\n');
      return;
    }
    const headingSize = HEADING_HALF_POINTS[tag];
    if (headingSize !== undefined) {
      this.out.push(`{\\pard\\sa200\\b\\fs${headingSize} ${this.inline(el)}\\b0\\par}\n`);
      return;
    }
    if (tag === 'p') {
      this.out.push(`{\\pard\\sa200 ${this.inline(el)}\\par}\n`);
      return;
    }
    if (tag === 'blockquote') {
      this.out.push(`{\\pard\\li720\\sa200 ${this.inline(el)}\\par}\n`);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      this.mapList(el, tag === 'ol', listDepth);
      return;
    }
    if (tag === 'table') {
      this.mapTable(el);
      return;
    }
    if (tag === 'img') {
      this.droppedImage = true;
      return;
    }
    if (tag === 'li') {
      // Malformed input: a <li> outside a <ul>/<ol>. Render as a plain
      // paragraph rather than silently losing its text.
      this.out.push(`{\\pard\\sa200 ${this.inline(el)}\\par}\n`);
      return;
    }

    // Unknown/unsupported block tag: keep its text, drop the formatting.
    this.droppedTags.add(tag);
    this.mapBlockChildren(el, listDepth);
  }

  private mapList(el: HtmlElement, ordered: boolean, depth: number): void {
    let index = 1;
    const indent = 360 + depth * 360;
    for (const child of el.children) {
      if (child.tagName.toLowerCase() !== 'li') continue;
      const marker = ordered ? `${index}.` : '\\bullet';
      this.out.push(
        `{\\pard\\li${indent}\\fi-360 ${marker}\\tab ${this.inline(child)}\\par}\n`,
      );
      index++;
      for (const nested of child.children) {
        const nestedTag = nested.tagName.toLowerCase();
        if (nestedTag === 'ul' || nestedTag === 'ol') {
          this.mapList(nested, nestedTag === 'ol', depth + 1);
        }
      }
    }
  }

  private mapTable(table: HtmlElement): void {
    for (const tr of table.querySelectorAll('tr')) {
      const cells = tr
        .querySelectorAll('th,td')
        .map((cell) => this.inline(cell).trim())
        .join(' \\tab ');
      this.out.push(`{\\pard\\sa100 ${cells}\\par}\n`);
    }
  }

  /** Inline run: text plus bold/italic/underline/strike/code/link formatting. */
  private inline(el: HtmlNode): string {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === TEXT_NODE) {
        out += escapeRtf(collapseWhitespace(node.textContent ?? ''));
        continue;
      }
      if (!isElement(node)) continue;
      const tag = node.tagName.toLowerCase();

      if (tag === 'br') {
        out += '\\line ';
        continue;
      }
      if (TRANSPARENT_TAGS.has(tag) || SILENT_SKIP_TAGS.has(tag)) {
        out += this.inline(node);
        continue;
      }
      if (tag === 'strong' || tag === 'b') {
        out += `{\\b ${this.inline(node)}}`;
      } else if (tag === 'em' || tag === 'i') {
        out += `{\\i ${this.inline(node)}}`;
      } else if (tag === 'u') {
        out += `{\\ul ${this.inline(node)}\\ulnone}`;
      } else if (tag === 's' || tag === 'strike' || tag === 'del') {
        out += `{\\strike ${this.inline(node)}}`;
      } else if (tag === 'code') {
        out += `{\\f1 ${this.inline(node)}}`;
      } else if (tag === 'a') {
        out += this.inlineLink(node);
      } else if (tag === 'img') {
        this.droppedImage = true;
      } else if (INLINE_TAGS.has(tag)) {
        out += this.inline(node);
      } else {
        this.droppedTags.add(tag);
        out += this.inline(node);
      }
    }
    return out;
  }

  private inlineLink(el: HtmlElement): string {
    const href = el.getAttribute('href') ?? '';
    const text = this.inline(el) || escapeRtf(href);
    if (!/^https?:\/\//i.test(href)) return text;
    const escapedHref = href.replace(/\\/g, '\\\\').replace(/[{}]/g, (c) => `\\${c}`);
    return `{\\field{\\*\\fldinst HYPERLINK "${escapedHref}"}{\\fldrslt {\\ul ${text}\\ulnone}}}`;
  }
}

function buildRtfDocument(bodyRtf: string): string {
  return (
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033\\uc1\n' +
    '{\\fonttbl{\\f0\\fswiss Helvetica;}{\\f1\\fmodern Courier New;}}\n' +
    bodyRtf +
    '}'
  );
}

export const htmlToRtfConverter: Converter = {
  id: 'doc:html-to-rtf',
  name: 'HTML to RTF',
  engine: 'pure-js',
  residency: 'worker',

  inputs: ['html'],
  outputs: ['rtf'],

  cost(): EdgeCost {
    // Same supported subset as html->docx, minus image embedding and real
    // list/table markup — a bit less structure survives than docx.
    return { retention: 0.7, effort: 2, structure: 0.55 };
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

    ctx.onProgress({ ratio: 0.4, message: 'Mapping to RTF' });

    const mapper = new RtfMapper();
    let rtf: string;
    try {
      const document = parseHtml(toFullHtmlDocument(html));
      const root = document.body ?? document.documentElement;
      rtf = buildRtfDocument(mapper.mapBody(root));
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This HTML file could not be parsed.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.8, message: 'Writing RTF' });

    try {
      await writeFile(output.path, rtf, 'utf8');
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

    return {
      bytes: Buffer.byteLength(rtf, 'utf8'),
      warnings: mapper.warnings.length > 0 ? mapper.warnings : undefined,
    };
  },
};
