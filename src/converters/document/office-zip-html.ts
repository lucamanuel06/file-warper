/**
 * `odt -> html`, `odp -> html`, `pptx -> html` — hand-rolled ZIP + XML
 * readers. All three formats are ZIP containers of XML; we deliberately
 * avoid `officeparser` (pulls in `tesseract.js`, which downloads OCR models
 * from a CDN, plus a second pinned `pdfjs-dist` — both unacceptable for an
 * offline app) in favor of `fflate` (unzip) + `fast-xml-parser` (XML, with
 * `preserveOrder: true` so mixed-tag document order — paragraph, heading,
 * list, paragraph — survives instead of being grouped by tag name).
 *
 * Scope, matching the project's "semantic HTML, not pixel-perfect"
 * philosophy: paragraphs, headings, and lists become `<p>`/`<h1-6>`/`<ul>
 * <li>`; slides become `<section>` elements in document/numeric order.
 * Character-level styling (bold/italic spans, list numbering vs bullets,
 * tables) is NOT resolved — that requires walking each format's separate
 * styles.xml/theme and is out of scope here. Images: ODT and PPTX inline
 * embedded images as `data:` URIs (self-contained HTML, matching what
 * mammoth already does for docx); ODP image inlining is dropped for time —
 * ODP slide text still extracts correctly, just without pictures.
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
import { XMLParser } from 'fast-xml-parser';
import { strFromU8, type Unzipped, unzipSync } from 'fflate';

// ---------------------------------------------------------------------------
// Shared XML tree helpers (fast-xml-parser, preserveOrder: true).
//
// Each node in a `preserveOrder` tree is an object with exactly one
// "tag name" key (or "#text") mapping to its children array, plus an
// optional ":@" key holding its attributes. Typed as `unknown` throughout
// and narrowed on access, rather than trusting the parser's `any` return.
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Whitespace between inline runs ("Hello <span>world</span>") is
  // significant in prose; block-level containers (paragraphs/lists) skip
  // stray whitespace text nodes explicitly, so this is safe to leave raw.
  trimValues: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nodeTag(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  for (const key of Object.keys(node)) {
    if (key !== ':@') return key;
  }
  return undefined;
}

function nodeChildren(node: unknown): readonly unknown[] {
  const tag = nodeTag(node);
  if (!tag || !isRecord(node)) return [];
  const children = node[tag];
  return Array.isArray(children) ? children : [];
}

function nodeAttrs(node: unknown): Record<string, unknown> {
  if (!isRecord(node)) return {};
  const attrs = node[':@'];
  return isRecord(attrs) ? attrs : {};
}

function attrString(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === 'string' ? v : undefined;
}

function nodeText(node: unknown): string {
  if (!isRecord(node)) return '';
  const v = node['#text'];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/** Depth-first, document-order search for every node tagged `tag`. */
function findAll(nodes: readonly unknown[], tag: string): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (nodeTag(node) === tag) out.push(node);
    out.push(...findAll(nodeChildren(node), tag));
  }
  return out;
}

/** Depth-first search for the first node tagged `tag`, anywhere below. */
function findFirst(nodes: readonly unknown[], tag: string): unknown | undefined {
  for (const node of nodes) {
    if (nodeTag(node) === tag) return node;
    const found = findFirst(nodeChildren(node), tag);
    if (found) return found;
  }
  return undefined;
}

/** Concatenates all `#text` content found anywhere in this subtree. */
function collectText(nodes: readonly unknown[]): string {
  let out = '';
  for (const node of nodes) {
    if (nodeTag(node) === '#text') {
      out += nodeText(node);
    } else {
      out += collectText(nodeChildren(node));
    }
  }
  return out;
}

function parseXmlEntry(zip: Unzipped, path: string): unknown[] {
  const bytes = zip[path];
  if (!bytes) return [];
  const parsed: unknown = xmlParser.parse(strFromU8(bytes));
  return Array.isArray(parsed) ? parsed : [];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function guessImageMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

function toDataUri(bytes: Uint8Array, path: string): string {
  return `data:${guessImageMime(path)};base64,${Buffer.from(bytes).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// ODT (OpenDocument Text)
// ---------------------------------------------------------------------------

function odtImageTag(frame: unknown, zip: Unzipped): string {
  const image = findFirst(nodeChildren(frame), 'draw:image');
  if (!image) return '';
  const href = attrString(nodeAttrs(image), '@_xlink:href');
  if (!href) return '';
  const path = href.replace(/^\.?\//, '');
  const bytes = zip[path];
  if (!bytes) return '';
  return `<img src="${toDataUri(bytes, path)}" alt="">`;
}

function odtInline(nodes: readonly unknown[], zip: Unzipped): string {
  let out = '';
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (tag === '#text') {
      out += escapeHtml(nodeText(node));
    } else if (tag === 'text:tab') {
      out += '\t';
    } else if (tag === 'text:line-break') {
      out += '<br>';
    } else if (tag === 'text:s') {
      const count = Number(attrString(nodeAttrs(node), '@_text:c') ?? '1') || 1;
      out += ' '.repeat(Math.max(1, count));
    } else if (tag === 'draw:frame') {
      out += odtImageTag(node, zip);
    } else if (tag) {
      // text:span, text:a, text:bookmark-start, etc: descend, keep the text.
      out += odtInline(nodeChildren(node), zip);
    }
  }
  return out;
}

function odtBlocks(nodes: readonly unknown[], zip: Unzipped): string {
  let out = '';
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (tag === 'text:p') {
      const inline = odtInline(nodeChildren(node), zip);
      if (inline.trim().length > 0) out += `<p>${inline}</p>\n`;
    } else if (tag === 'text:h') {
      const raw = Number(attrString(nodeAttrs(node), '@_text:outline-level') ?? '1') || 1;
      const level = Math.min(6, Math.max(1, raw));
      const inline = odtInline(nodeChildren(node), zip);
      out += `<h${level}>${inline}</h${level}>\n`;
    } else if (tag === 'text:list') {
      out += `<ul>\n${odtListItems(nodeChildren(node), zip)}</ul>\n`;
    } else if (tag === 'text:section') {
      out += odtBlocks(nodeChildren(node), zip);
    }
  }
  return out;
}

function odtListItems(nodes: readonly unknown[], zip: Unzipped): string {
  let out = '';
  for (const node of nodes) {
    if (nodeTag(node) !== 'text:list-item') continue;
    out += `<li>${odtBlocks(nodeChildren(node), zip).trim()}</li>\n`;
  }
  return out;
}

function convertOdt(zip: Unzipped): string {
  const root = parseXmlEntry(zip, 'content.xml');
  const body = findFirst(root, 'office:body');
  const text = body ? findFirst(nodeChildren(body), 'office:text') : undefined;
  return text ? odtBlocks(nodeChildren(text), zip) : '';
}

// ---------------------------------------------------------------------------
// ODP (OpenDocument Presentation) — image inlining dropped, see file header.
// ---------------------------------------------------------------------------

function odpSlideHtml(page: unknown): string {
  const frames = findAll(nodeChildren(page), 'draw:frame');
  let out = '';
  for (const frame of frames) {
    const textBoxes = findAll(nodeChildren(frame), 'draw:text-box');
    for (const box of textBoxes) {
      for (const p of nodeChildren(box)) {
        if (nodeTag(p) !== 'text:p') continue;
        const text = collectText(nodeChildren(p));
        if (text.trim().length > 0) out += `<p>${escapeHtml(text)}</p>\n`;
      }
    }
  }
  return out;
}

function convertOdp(zip: Unzipped): { html: string; slideCount: number } {
  const root = parseXmlEntry(zip, 'content.xml');
  const pages = findAll(root, 'draw:page');
  const html = pages
    .map((page) => `<section>\n${odpSlideHtml(page)}</section>\n`)
    .join('');
  return { html, slideCount: pages.length };
}

// ---------------------------------------------------------------------------
// PPTX (OOXML Presentation)
// ---------------------------------------------------------------------------

function pptxResolveTarget(target: string): string {
  if (target.startsWith('../')) return `ppt/${target.slice(3)}`;
  if (target.startsWith('/')) return target.slice(1);
  return `ppt/slides/${target}`;
}

function pptxRelMap(zip: Unzipped, slidePath: string): Map<string, string> {
  const relsPath = `${slidePath.replace('ppt/slides/', 'ppt/slides/_rels/')}.rels`;
  const map = new Map<string, string>();
  const relationships = findAll(parseXmlEntry(zip, relsPath), 'Relationship');
  for (const rel of relationships) {
    const attrs = nodeAttrs(rel);
    const id = attrString(attrs, '@_Id');
    const target = attrString(attrs, '@_Target');
    if (id && target) map.set(id, pptxResolveTarget(target));
  }
  return map;
}

function pptxShapeParagraphs(shapeChildren: readonly unknown[]): string {
  let out = '';
  for (const p of findAll(shapeChildren, 'a:p')) {
    const runs = findAll(nodeChildren(p), 'a:t');
    const text = runs.map((r) => collectText(nodeChildren(r))).join('');
    if (text.trim().length > 0) out += `<p>${escapeHtml(text)}</p>\n`;
  }
  return out;
}

function pptxPicture(node: unknown, zip: Unzipped, rels: Map<string, string>): string {
  const blip = findFirst(nodeChildren(node), 'a:blip');
  if (!blip) return '';
  const embed = attrString(nodeAttrs(blip), '@_r:embed');
  if (!embed) return '';
  const path = rels.get(embed);
  if (!path) return '';
  const bytes = zip[path];
  if (!bytes) return '';
  return `<img src="${toDataUri(bytes, path)}" alt="">\n`;
}

function pptxTree(
  nodes: readonly unknown[],
  zip: Unzipped,
  rels: Map<string, string>,
): string {
  let out = '';
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (tag === 'p:sp') {
      out += pptxShapeParagraphs(nodeChildren(node));
    } else if (tag === 'p:pic') {
      out += pptxPicture(node, zip, rels);
    } else if (tag === 'p:grpSp') {
      out += pptxTree(nodeChildren(node), zip, rels);
    }
  }
  return out;
}

function pptxSlideNumber(path: string): number {
  const match = /slide(\d+)\.xml$/.exec(path);
  return match?.[1] ? Number(match[1]) : 0;
}

function convertPptx(zip: Unzipped): { html: string; slideCount: number } {
  const slidePaths = Object.keys(zip)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => pptxSlideNumber(a) - pptxSlideNumber(b));

  let html = '';
  for (const slidePath of slidePaths) {
    const root = parseXmlEntry(zip, slidePath);
    const spTree = findFirst(root, 'p:spTree');
    const rels = pptxRelMap(zip, slidePath);
    const body = spTree ? pptxTree(nodeChildren(spTree), zip, rels) : '';
    html += `<section>\n${body}</section>\n`;
  }
  return { html, slideCount: slidePaths.length };
}

// ---------------------------------------------------------------------------
// Shared convert() plumbing.
// ---------------------------------------------------------------------------

function wrapHtml(body: string): string {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

async function unzipInput(
  input: ConversionInput,
  userMessage: string,
): Promise<Unzipped> {
  const buffer = await input.readBuffer();
  try {
    return unzipSync(new Uint8Array(buffer));
  } catch (err: unknown) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function writeHtml(output: ConversionOutput, body: string): Promise<number> {
  const html = wrapHtml(body);
  await writeFile(output.path, html, 'utf8');
  return Buffer.byteLength(html, 'utf8');
}

function checkCancelled(ctx: ConvertContext): void {
  if (ctx.signal.aborted) {
    throw new ConversionError({
      code: 'E_CANCELLED',
      userMessage: 'Conversion was cancelled.',
    });
  }
}

export const odtToHtml: Converter = {
  id: 'doc:odt-to-html',
  name: 'OpenDocument Text to HTML',
  engine: 'pure-js',
  inputs: ['odt'],
  outputs: ['html'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    return { retention: 0.7, effort: 3, structure: 0.55 };
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
    checkCancelled(ctx);
    const zip = await unzipInput(
      input,
      'This OpenDocument Text file could not be read. It may be corrupted.',
    );
    const bytes = await writeHtml(output, convertOdt(zip));
    ctx.onProgress({ ratio: 1 });
    return {
      bytes,
      warnings: [
        'Converted paragraphs, headings, and lists to HTML. Character styling (colors, exact fonts) and tables are not preserved; numbered lists render as bullet lists.',
      ],
    };
  },
};

export const odpToHtml: Converter = {
  id: 'doc:odp-to-html',
  name: 'OpenDocument Presentation to HTML',
  engine: 'pure-js',
  inputs: ['odp'],
  outputs: ['html'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    return { retention: 0.55, effort: 3, structure: 0.5 };
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
    checkCancelled(ctx);
    const zip = await unzipInput(
      input,
      'This OpenDocument Presentation file could not be read. It may be corrupted.',
    );
    const { html, slideCount } = convertOdp(zip);
    const bytes = await writeHtml(output, html);
    ctx.onProgress({ ratio: 1 });
    return {
      bytes,
      warnings: [
        'Converted slide text to one <section> per slide. Slide images, layout, and character styling were dropped.',
      ],
      meta: { slideCount },
    };
  },
};

export const pptxToHtml: Converter = {
  id: 'doc:pptx-to-html',
  name: 'PowerPoint Presentation to HTML',
  engine: 'pure-js',
  inputs: ['pptx'],
  outputs: ['html'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    return { retention: 0.65, effort: 3, structure: 0.5 };
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
    checkCancelled(ctx);
    const zip = await unzipInput(
      input,
      'This PowerPoint file could not be read. It may be corrupted.',
    );
    const { html, slideCount } = convertPptx(zip);
    const bytes = await writeHtml(output, html);
    ctx.onProgress({ ratio: 1 });
    return {
      bytes,
      warnings: [
        'Converted slide text and pictures to one <section> per slide, in slide order. Layout, animations, and character styling were dropped.',
      ],
      meta: { slideCount },
    };
  },
};
