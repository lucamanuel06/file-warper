/**
 * `epub -> html`. EPUB is a ZIP container: `META-INF/container.xml` points
 * at the OPF package document, whose `<spine>` gives the reading order of
 * XHTML content documents (referenced indirectly through `<manifest>` item
 * ids). Each chapter's `<body>` content is concatenated into one HTML file,
 * wrapped in its own `<section>`, with any images the chapter references
 * inlined as `data:` URIs (self-contained output, matching the other
 * document parsers in this directory).
 *
 * Scope: this reads structure and text content; it does not reproduce EPUB
 * CSS, embedded fonts, or navigation (nav/TOC). Chapters that fail to parse
 * are skipped with a warning rather than failing the whole conversion.
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
import { parseHtml } from './dom';

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
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

function findAll(nodes: readonly unknown[], tag: string): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (nodeTag(node) === tag) out.push(node);
    out.push(...findAll(nodeChildren(node), tag));
  }
  return out;
}

function findFirst(nodes: readonly unknown[], tag: string): unknown | undefined {
  for (const node of nodes) {
    if (nodeTag(node) === tag) return node;
    const found = findFirst(nodeChildren(node), tag);
    if (found) return found;
  }
  return undefined;
}

function parseXml(text: string): unknown[] {
  const parsed: unknown = xmlParser.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx + 1);
}

/** Resolves a possibly-relative href against the directory of `basePath`. */
function resolveRelative(basePath: string, href: string): string {
  if (href.startsWith('/')) return href.slice(1);
  const parts = (dirOf(basePath) + href).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
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
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function toDataUri(bytes: Uint8Array, path: string): string {
  return `data:${guessImageMime(path)};base64,${Buffer.from(bytes).toString('base64')}`;
}

interface OpfInfo {
  readonly opfPath: string;
  /** Manifest item id -> href (relative to the OPF's directory). */
  readonly manifest: ReadonlyMap<string, string>;
  /** Spine item ids, in reading order. */
  readonly spine: readonly string[];
}

function findOpfPath(zip: Unzipped): string {
  const containerBytes = zip['META-INF/container.xml'];
  if (!containerBytes) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage:
        'This EPUB file is missing its container manifest and could not be read.',
    });
  }
  const container = parseXml(strFromU8(containerBytes));
  const rootfile = findFirst(container, 'rootfile');
  const fullPath = rootfile ? attrString(nodeAttrs(rootfile), '@_full-path') : undefined;
  if (!fullPath) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: 'This EPUB file does not point to a valid package document.',
    });
  }
  return fullPath;
}

function readOpf(zip: Unzipped, opfPath: string): OpfInfo {
  const opfBytes = zip[opfPath];
  if (!opfBytes) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: 'This EPUB file references a package document that does not exist.',
    });
  }
  const opf = parseXml(strFromU8(opfBytes));

  const manifest = new Map<string, string>();
  for (const item of findAll(opf, 'item')) {
    const attrs = nodeAttrs(item);
    const id = attrString(attrs, '@_id');
    const href = attrString(attrs, '@_href');
    if (id && href) manifest.set(id, href);
  }

  const spine: string[] = [];
  for (const itemref of findAll(opf, 'itemref')) {
    const idref = attrString(nodeAttrs(itemref), '@_idref');
    if (idref) spine.push(idref);
  }

  return { opfPath, manifest, spine };
}

/** Inlines every `<img src>` in a chapter fragment as a base64 data URI. */
function inlineImages(bodyHtml: string, zip: Unzipped, chapterPath: string): string {
  const document = parseHtml(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  for (const img of [...document.querySelectorAll('img')]) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;
    const resolved = resolveRelative(chapterPath, src);
    const bytes = zip[resolved];
    if (!bytes) continue;
    img.setAttribute('src', toDataUri(bytes, resolved));
  }
  return document.body?.innerHTML ?? bodyHtml;
}

function wrapHtml(body: string): string {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

export const epubToHtml: Converter = {
  id: 'doc:epub-to-html',
  name: 'EPUB to HTML',
  engine: 'pure-js',
  inputs: ['epub'],
  outputs: ['html'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    // Chapter text and basic markup survive; EPUB CSS, embedded fonts, and
    // navigation are not reproduced.
    return { retention: 0.75, effort: 3, structure: 0.6 };
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
    let zip: Unzipped;
    try {
      zip = unzipSync(new Uint8Array(buffer));
    } catch (err: unknown) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This EPUB file could not be read. It may be corrupted.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const opfPath = findOpfPath(zip);
    const { manifest, spine } = readOpf(zip, opfPath);

    const skippedChapters: string[] = [];
    const sections: string[] = [];
    let index = 0;
    for (const idref of spine) {
      index++;
      const href = manifest.get(idref);
      if (!href) {
        skippedChapters.push(idref);
        continue;
      }
      const chapterPath = resolveRelative(opfPath, href);
      const bytes = zip[chapterPath];
      if (!bytes) {
        skippedChapters.push(idref);
        continue;
      }

      const chapterHtml = strFromU8(bytes);
      const document = parseHtml(chapterHtml);
      const bodyHtml = document.body?.innerHTML ?? '';
      sections.push(
        `<section>\n${inlineImages(bodyHtml, zip, chapterPath)}\n</section>\n`,
      );

      ctx.onProgress({
        ratio: index / spine.length,
        message: `Chapter ${index}/${spine.length}`,
      });
    }

    const html = wrapHtml(sections.join(''));
    await writeFile(output.path, html, 'utf8');

    const warnings = [
      'Converted chapter text and inline markup to HTML, one <section> per chapter. EPUB stylesheets, embedded fonts, and the table of contents/navigation are not reproduced.',
    ];
    if (skippedChapters.length > 0) {
      warnings.push(
        `${skippedChapters.length} spine item(s) could not be located and were skipped.`,
      );
    }

    return {
      bytes: Buffer.byteLength(html, 'utf8'),
      warnings,
      meta: { chapterCount: sections.length },
    };
  },
};
