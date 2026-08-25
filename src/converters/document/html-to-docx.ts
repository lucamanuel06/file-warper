/**
 * `html -> docx` via a hand-rolled DOM walker (`linkedom`) over the `docx`
 * builder API (there is no maintained "just convert this HTML" library for
 * modern Node — `html-to-docx` is unmaintained and broken on current
 * releases, which is why this project bans it).
 *
 * Supported tag subset: h1-h6, p, strong/b, em/i, u, s/strike/del, ul, ol,
 * li, table (tr/td/th), img (data: URIs only), a (http/https only), code,
 * blockquote, hr.
 *
 * A few pragmatic, deliberate extensions beyond the literal list:
 *  - `html`, `body`, `div`, `span`, `section`, `article`, `main`, `header`,
 *    `footer`, `nav`, `aside` are treated as *transparent* structural
 *    wrappers: we recurse into their children without emitting a warning,
 *    because dropping them would also drop everything nested inside —
 *    these tags carry no formatting docx would render anyway.
 *  - `head`, `title`, `meta`, `link`, `base`, `script`, `style`, `noscript`
 *    are silently skipped (no warning, no recursion) — they are invisible
 *    document metadata, not lost content.
 *  - `b`/`i`/`strike`/`del` are treated as synonyms of `strong`/`em`/`s`
 *    since they mean exactly the same formatting.
 *
 * Everything else outside the subset is genuinely unsupported. Elements
 * that are pure embeds/controls with no meaningful text content of their
 * own (figure, video, audio, svg, iframe, canvas, object, embed, form
 * controls, ...) are dropped along with their whole subtree. Any other
 * unrecognised tag (mark, sup, sub, pre, custom elements, ...) keeps its
 * text content but loses its formatting — losing the wrapper, not the
 * words, reads better to a user than losing a paragraph outright. Either
 * way, each distinct dropped tag name produces exactly one deduplicated
 * warning: `Dropped unsupported element: <tag>`.
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
import type { ILevelsOptions, ParagraphChild } from 'docx';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { parseHtml } from './dom';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const ORDERED_LIST_REFERENCE = 'fw-html-docx-ol';
const MAX_LIST_LEVELS = 6;

const DEFAULT_IMAGE_WIDTH = 300;
const DEFAULT_IMAGE_HEIGHT = 200;

// ---------------------------------------------------------------------------
// Minimal structural DOM types (see module doc for why we don't import
// linkedom's own Node/Element types: they're written against `lib.dom`,
// which this project's tsconfig deliberately doesn't include for src/core
// and friends).
// ---------------------------------------------------------------------------

interface HtmlNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<HtmlNode>;
}

interface HtmlElementNode extends HtmlNode {
  readonly tagName: string;
  readonly children: ArrayLike<HtmlElementNode>;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<HtmlElementNode>;
}

function isElement(node: HtmlNode): node is HtmlElementNode {
  return node.nodeType === ELEMENT_NODE;
}

function childArray(node: HtmlNode): HtmlNode[] {
  return Array.from(node.childNodes);
}

function childElements(el: HtmlElementNode): HtmlElementNode[] {
  return Array.from(el.children);
}

// ---------------------------------------------------------------------------
// Tag classification
// ---------------------------------------------------------------------------

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
  'noscript',
]);

/** Embeds/controls with no meaningful text of their own — warn, skip subtree. */
const OPAQUE_TAGS = new Set([
  'figure',
  'figcaption',
  'picture',
  'source',
  'track',
  'video',
  'audio',
  'svg',
  'iframe',
  'canvas',
  'object',
  'embed',
  'map',
  'area',
  'param',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'label',
  'template',
]);

const HEADING_LEVELS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};

interface RunStyle {
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly underline?: Record<string, never>;
  readonly strike?: boolean;
  readonly code?: boolean;
}

/**
 * `linkedom`'s `parseHTML` only synthesises a proper `html/head/body`
 * skeleton when the input already declares `<html>`. A bare fragment (e.g.
 * `<p>Hello</p>`) gets its outermost element promoted to `documentElement`
 * directly, with no `body` at all — so `document.body` ends up `null` (or
 * worse, a nonsensical extra element) for exactly the kind of snippet this
 * converter is designed to accept. Always parsing a full shell sidesteps
 * that entirely: `document.body` is then reliably present.
 */
function toFullHtmlDocument(html: string): string {
  return /<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/[\t\n\r ]+/g, ' ');
}

function mimeToDocxImageType(mime: string): 'jpg' | 'png' | 'gif' | 'bmp' | undefined {
  switch (mime.toLowerCase().trim()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    default:
      return undefined;
  }
}

function parseDimension(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildOrderedListLevels(): ILevelsOptions[] {
  const formats = [
    LevelFormat.DECIMAL,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_ROMAN,
  ];
  return Array.from({ length: MAX_LIST_LEVELS }, (_, level) => ({
    level,
    format: formats[level % formats.length] ?? LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
  }));
}

/**
 * Walks a parsed HTML DOM and produces `docx` body content plus a list of
 * deduplicated "dropped element" / "dropped image" warnings.
 */
class DocxMapper {
  private readonly droppedTags = new Set<string>();
  private readonly imageWarnings = new Set<string>();

  get warnings(): string[] {
    const tagWarnings = [...this.droppedTags]
      .sort()
      .map((tag) => `Dropped unsupported element: <${tag}>`);
    return [...tagWarnings, ...this.imageWarnings];
  }

  mapBody(root: HtmlElementNode): (Paragraph | Table)[] {
    return this.mapBlockChildren(root, 0);
  }

  private mapBlockChildren(parent: HtmlNode, listDepth: number): (Paragraph | Table)[] {
    const out: (Paragraph | Table)[] = [];
    for (const node of childArray(parent)) {
      if (node.nodeType === TEXT_NODE) {
        const text = collapseWhitespace(node.textContent ?? '').trim();
        if (text.length > 0) {
          out.push(new Paragraph({ children: [new TextRun(text)] }));
        }
        continue;
      }
      if (!isElement(node)) continue;
      const tag = node.tagName.toLowerCase();

      if (SILENT_SKIP_TAGS.has(tag)) continue;
      if (OPAQUE_TAGS.has(tag)) {
        this.droppedTags.add(tag);
        continue;
      }
      if (TRANSPARENT_TAGS.has(tag)) {
        out.push(...this.mapBlockChildren(node, listDepth));
        continue;
      }

      switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          out.push(
            new Paragraph({
              heading: HEADING_LEVELS[tag],
              children: this.mapInline(node, {}),
            }),
          );
          break;
        case 'p':
          out.push(new Paragraph({ children: this.mapInline(node, {}) }));
          break;
        case 'blockquote':
          out.push(
            new Paragraph({
              indent: { left: 720 },
              children: this.mapInline(node, { italics: true }),
            }),
          );
          break;
        case 'hr':
          out.push(
            new Paragraph({
              border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999' } },
              spacing: { after: 200 },
            }),
          );
          break;
        case 'ul':
          out.push(...this.mapList(node, listDepth, false));
          break;
        case 'ol':
          out.push(...this.mapList(node, listDepth, true));
          break;
        case 'li':
          // Malformed markup: a bare <li> with no <ul>/<ol> parent.
          out.push(
            new Paragraph({
              bullet: { level: listDepth },
              children: this.mapInline(node, {}),
            }),
          );
          break;
        case 'table': {
          const table = this.mapTable(node);
          if (table) out.push(table);
          break;
        }
        default:
          // Unknown, non-opaque tag: keep the text, drop the wrapper.
          this.droppedTags.add(tag);
          out.push(...this.mapBlockChildren(node, listDepth));
          break;
      }
    }
    return out;
  }

  private mapList(listEl: HtmlElementNode, depth: number, ordered: boolean): Paragraph[] {
    const level = Math.min(depth, MAX_LIST_LEVELS - 1);
    const out: Paragraph[] = [];

    for (const li of childElements(listEl)) {
      if (li.tagName.toLowerCase() !== 'li') continue;

      const inlineNodes: HtmlNode[] = [];
      const nestedLists: HtmlElementNode[] = [];
      for (const child of childArray(li)) {
        if (isElement(child) && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
          nestedLists.push(child);
        } else {
          inlineNodes.push(child);
        }
      }

      const runs = this.mapInlineNodes(inlineNodes, {});
      out.push(
        new Paragraph(
          ordered
            ? { numbering: { reference: ORDERED_LIST_REFERENCE, level }, children: runs }
            : { bullet: { level }, children: runs },
        ),
      );

      for (const nested of nestedLists) {
        const nestedOrdered = nested.tagName.toLowerCase() === 'ol';
        out.push(...this.mapList(nested, depth + 1, nestedOrdered));
      }
    }

    return out;
  }

  private mapTable(tableEl: HtmlElementNode): Table | undefined {
    const trs = Array.from(tableEl.querySelectorAll('tr'));
    const rows = trs
      .map((tr) => {
        const cells = childElements(tr).filter((c) =>
          ['td', 'th'].includes(c.tagName.toLowerCase()),
        );
        if (cells.length === 0) return undefined;
        return new TableRow({
          children: cells.map(
            (cell) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: this.mapInline(
                      cell,
                      cell.tagName.toLowerCase() === 'th' ? { bold: true } : {},
                    ),
                  }),
                ],
              }),
          ),
        });
      })
      .filter((row): row is TableRow => row !== undefined);

    if (rows.length === 0) return undefined;
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
  }

  private mapInline(el: HtmlElementNode, style: RunStyle): ParagraphChild[] {
    return this.mapInlineNodes(childArray(el), style);
  }

  private mapInlineNodes(nodes: readonly HtmlNode[], style: RunStyle): ParagraphChild[] {
    const runs: ParagraphChild[] = [];

    for (const node of nodes) {
      if (node.nodeType === TEXT_NODE) {
        const text = collapseWhitespace(node.textContent ?? '');
        if (text.length > 0) runs.push(this.makeTextRun(text, style));
        continue;
      }
      if (!isElement(node)) continue;
      const tag = node.tagName.toLowerCase();

      if (SILENT_SKIP_TAGS.has(tag)) continue;
      if (OPAQUE_TAGS.has(tag)) {
        this.droppedTags.add(tag);
        continue;
      }

      switch (tag) {
        case 'strong':
        case 'b':
          runs.push(...this.mapInlineNodes(childArray(node), { ...style, bold: true }));
          break;
        case 'em':
        case 'i':
          runs.push(
            ...this.mapInlineNodes(childArray(node), { ...style, italics: true }),
          );
          break;
        case 'u':
          runs.push(
            ...this.mapInlineNodes(childArray(node), { ...style, underline: {} }),
          );
          break;
        case 's':
        case 'strike':
        case 'del':
          runs.push(...this.mapInlineNodes(childArray(node), { ...style, strike: true }));
          break;
        case 'code':
          runs.push(...this.mapInlineNodes(childArray(node), { ...style, code: true }));
          break;
        case 'br':
          runs.push(new TextRun({ text: '', break: 1 }));
          break;
        case 'span':
          runs.push(...this.mapInlineNodes(childArray(node), style));
          break;
        case 'a': {
          const href = node.getAttribute('href') ?? '';
          const children = this.mapInlineNodes(childArray(node), style);
          const withFallback =
            children.length > 0 ? children : [this.makeTextRun(href, style)];
          if (/^https?:\/\//i.test(href)) {
            runs.push(new ExternalHyperlink({ link: href, children: withFallback }));
          } else {
            runs.push(...withFallback);
          }
          break;
        }
        case 'img': {
          const run = this.mapImage(node);
          if (run) runs.push(run);
          break;
        }
        default:
          // Unknown, non-opaque inline tag: keep the text, drop the styling.
          this.droppedTags.add(tag);
          runs.push(...this.mapInlineNodes(childArray(node), style));
          break;
      }
    }

    return runs;
  }

  private makeTextRun(text: string, style: RunStyle): TextRun {
    return new TextRun({
      text,
      bold: style.bold,
      italics: style.italics,
      underline: style.underline,
      strike: style.strike,
      font: style.code ? { name: 'Consolas' } : undefined,
    });
  }

  private mapImage(el: HtmlElementNode): ImageRun | undefined {
    const src = el.getAttribute('src') ?? '';
    if (!src.startsWith('data:')) {
      this.imageWarnings.add(
        'Dropped a remote image — this app converts offline only and does not fetch it.',
      );
      return undefined;
    }

    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
    if (!match) {
      this.imageWarnings.add('Dropped an image with an unrecognised data URI.');
      return undefined;
    }
    const [, mimeType, isBase64, payload] = match;
    const type = mimeToDocxImageType(mimeType ?? '');
    if (!type) {
      this.imageWarnings.add(`Dropped an unsupported image type: ${mimeType}.`);
      return undefined;
    }

    let data: Buffer;
    try {
      data = isBase64
        ? Buffer.from(payload ?? '', 'base64')
        : Buffer.from(decodeURIComponent(payload ?? ''), 'binary');
    } catch {
      this.imageWarnings.add('Dropped an image that could not be decoded.');
      return undefined;
    }
    if (data.byteLength === 0) {
      this.imageWarnings.add('Dropped an empty image.');
      return undefined;
    }

    const width = parseDimension(el.getAttribute('width')) ?? DEFAULT_IMAGE_WIDTH;
    const height = parseDimension(el.getAttribute('height')) ?? DEFAULT_IMAGE_HEIGHT;

    return new ImageRun({ type, data, transformation: { width, height } });
  }
}

export const htmlToDocxConverter: Converter = {
  id: 'doc:html-to-docx',
  name: 'HTML to Word Document',
  engine: 'pure-js',
  residency: 'worker',

  inputs: ['html'],
  outputs: ['docx'],

  cost(): EdgeCost {
    // Real semantic-HTML -> docx fidelity for the supported subset; layout
    // outside that subset (and anything requiring pixel-perfect CSS) is not
    // reproduced.
    return { retention: 0.8, effort: 4, structure: 0.7 };
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

    ctx.onProgress({ ratio: 0.3, message: 'Mapping to Word structure' });

    const mapper = new DocxMapper();
    let bodyChildren: (Paragraph | Table)[];
    try {
      const document = parseHtml(toFullHtmlDocument(html));
      const root = (document.body ??
        document.documentElement) as unknown as HtmlElementNode;
      bodyChildren = mapper.mapBody(root);
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This HTML file could not be parsed.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    if (bodyChildren.length === 0) {
      bodyChildren = [new Paragraph('')];
    }

    ctx.onProgress({ ratio: 0.6, message: 'Building Word document' });

    let buffer: Buffer;
    try {
      const doc = new Document({
        numbering: {
          config: [
            { reference: ORDERED_LIST_REFERENCE, levels: buildOrderedListLevels() },
          ],
        },
        sections: [{ children: bodyChildren }],
      });
      buffer = await Packer.toBuffer(doc);
    } catch (cause) {
      throw new ConversionError({
        code: 'E_ENGINE',
        userMessage: 'The Word document could not be built.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.9, message: 'Writing docx' });

    try {
      await writeFile(output.path, buffer);
    } catch (cause) {
      throw new ConversionError({
        code: 'E_PERMISSION',
        userMessage: `Could not write the Word document to "${output.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    const warnings = mapper.warnings;
    return {
      bytes: buffer.byteLength,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};
