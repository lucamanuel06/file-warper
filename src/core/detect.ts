/**
 * @warp/core — three-stage format detection: magic bytes -> extension ->
 * content sniff. See docs/spec-core-architecture.md §3 and
 * docs/spec-engines.md §E.
 */

import { basename } from 'node:path';
import chardet from 'chardet';
import { unzipSync } from 'fflate';
import iconv from 'iconv-lite';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { FORMATS, formatFromFilename, getFormat } from './formats';
import { readFileCapped, readHead, statSize } from './fs-helpers';
import type { FormatCategory, FormatDef, FormatId, MagicSig, ProbeResult } from './types';

const HEAD_SIZE = 64 * 1024;
const SNIFF_CAP = 1024 * 1024;
/** Zip-family disambiguation needs the central directory, which lives at the
 * END of the archive — so this cap is generous compared to `SNIFF_CAP`. */
const ZIP_PEEK_CAP = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Stage 1 — magic bytes
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function matchesSignature(head: Buffer, sig: MagicSig): boolean {
  const sigBytes = hexToBytes(sig.bytes);
  const maskBytes = sig.mask ? hexToBytes(sig.mask) : undefined;
  if (sig.offset + sigBytes.length > head.length) return false;
  for (let i = 0; i < sigBytes.length; i++) {
    const mask = maskBytes ? (maskBytes[i] as number) : 0xff;
    const want = (sigBytes[i] as number) & mask;
    const got = (head[sig.offset + i] as number) & mask;
    if (got !== want) return false;
  }
  return true;
}

/** All formats whose magic matches, most-specific (longest byte match) first. */
function magicCandidates(head: Buffer): FormatDef[] {
  const hits: { def: FormatDef; specificity: number }[] = [];
  for (const def of FORMATS) {
    if (!def.magic) continue;
    for (const sig of def.magic) {
      if (matchesSignature(head, sig)) {
        hits.push({ def, specificity: sig.bytes.length });
        break;
      }
    }
  }
  hits.sort((a, b) => b.specificity - a.specificity);
  return hits.map((h) => h.def);
}

const ZIP_MIME_TO_FORMAT: Readonly<Record<string, FormatId>> = {
  'application/epub+zip': 'epub',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

/** Peek `[Content_Types].xml` / `mimetype` to tell zip-family formats apart. */
function disambiguateZip(full: Buffer): FormatId | undefined {
  try {
    const entries = unzipSync(new Uint8Array(full), {
      filter: (f) =>
        f.name === 'mimetype' ||
        f.name === '[Content_Types].xml' ||
        f.name === 'META-INF/manifest.xml',
    });
    const mimetype = entries.mimetype;
    if (mimetype) {
      const mime = Buffer.from(mimetype).toString('utf8').trim();
      const hit = ZIP_MIME_TO_FORMAT[mime];
      if (hit) return hit;
    }
    const contentTypes = entries['[Content_Types].xml'];
    if (contentTypes) {
      const xml = Buffer.from(contentTypes).toString('utf8');
      if (xml.includes('wordprocessingml')) return 'docx';
      if (xml.includes('spreadsheetml')) return 'xlsx';
      if (xml.includes('presentationml')) return 'pptx';
    }
    if (entries['META-INF/manifest.xml']) {
      const xml = Buffer.from(entries['META-INF/manifest.xml']).toString('utf8');
      if (xml.includes('opendocument.text')) return 'odt';
      if (xml.includes('opendocument.spreadsheet')) return 'ods';
      if (xml.includes('opendocument.presentation')) return 'odp';
    }
  } catch {
    // Not a fully-formed zip within the bytes we read (e.g. truncated head).
  }
  return undefined;
}

const ZIP_FAMILY_IDS = new Set([
  'zip',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'epub',
]);

// ---------------------------------------------------------------------------
// Stage 3 — content sniff (text formats only)
// ---------------------------------------------------------------------------

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function decodeText(buf: Buffer): string | undefined {
  if (buf.length === 0) return '';
  if (looksBinary(buf)) return undefined;
  const detected = chardet.detect(buf);
  const encoding = detected && iconv.encodingExists(detected) ? detected : 'utf-8';
  try {
    return iconv.decode(buf, encoding).replace(/^\uFEFF/, '');
  } catch {
    return buf.toString('utf8');
  }
}

function isJsonLike(trimmed: string): boolean {
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isNdjson(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  return lines.every((line) => {
    if (!(line.startsWith('{') || line.startsWith('['))) return false;
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

function isTomlLike(trimmed: string): boolean {
  if (trimmed.length === 0) return false;
  try {
    const doc = parseToml(trimmed);
    return typeof doc === 'object' && doc !== null && Object.keys(doc).length > 0;
  } catch {
    return false;
  }
}

/**
 * YAML is a JSON superset and `yaml.parse` "succeeds" on almost any plain
 * text by treating it as a single scalar string. Only count it as YAML when
 * the parse yields real structure AND the source has a YAML-shaped line.
 */
function isYamlLike(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') return false;
  return /^(---\s*$|[\w"'.-]+\s*:(\s|$)|-\s)/m.test(text);
}

function countChar(line: string, ch: string): number {
  let n = 0;
  for (const c of line) if (c === ch) n++;
  return n;
}

function sniffDelimiter(text: string): ',' | '\t' | undefined {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 20);
  if (lines.length < 2) return undefined;
  for (const delim of [',', '\t'] as const) {
    const counts = lines.map((l) => countChar(l, delim));
    const first = counts[0] as number;
    if (first > 0 && counts.every((c) => c === first)) return delim;
  }
  return undefined;
}

function sniffText(text: string): FormatId | undefined {
  const trimmed = text.trimStart();
  if (/^<svg[\s>]/i.test(trimmed)) return 'svg';
  if (/^<\?xml/i.test(trimmed)) return 'xml';
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return 'html';
  if (isJsonLike(trimmed)) return 'json';
  if (isNdjson(text)) return 'jsonl';
  if (isTomlLike(trimmed)) return 'toml';
  if (isYamlLike(text)) return 'yaml';
  const delim = sniffDelimiter(text);
  if (delim === ',') return 'csv';
  if (delim === '\t') return 'tsv';
  return 'txt';
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function categoryFor(format: FormatId | undefined): FormatCategory | null {
  if (!format) return null;
  return getFormat(format)?.category ?? null;
}

export async function probeFile(filePath: string): Promise<ProbeResult> {
  const name = basename(filePath);
  const size = await statSize(filePath);
  const head = await readHead(filePath, HEAD_SIZE);
  const warnings: string[] = [];

  const extFormat = formatFromFilename(name);
  const candidates = magicCandidates(head);

  let format: FormatId | undefined;
  let confidence: ProbeResult['confidence'] = 'none';

  if (candidates.length > 0) {
    const top = candidates[0] as FormatDef;
    const tied = candidates.filter(
      (c) => magicSpecificity(c, head) === magicSpecificity(top, head),
    );

    if (tied.length === 1) {
      format = top.id;
    } else if (extFormat && tied.some((c) => c.id === extFormat)) {
      format = extFormat;
    } else if (tied.some((c) => ZIP_FAMILY_IDS.has(c.id))) {
      const full =
        size <= head.length ? head : await readFileCapped(filePath, ZIP_PEEK_CAP);
      format =
        disambiguateZip(full) ?? tied.find((c) => c.id === 'zip')?.id ?? tied[0]?.id;
    } else {
      format = [...tied.map((c) => c.id)].sort()[0];
      warnings.push(
        `Could not tell ${tied.map((c) => c.label).join(', ')} apart from magic bytes alone; guessed ${getFormat(format ?? '')?.label ?? format}.`,
      );
    }
    confidence = 'magic';

    if (extFormat && extFormat !== format) {
      const fd = getFormat(format ?? '');
      if (fd?.binary) {
        warnings.push(
          `This file's extension doesn't match its contents — it's actually ${fd.label}.`,
        );
      }
    }
  } else if (extFormat) {
    format = extFormat;
    confidence = 'extension';
  } else {
    const sniffBuf = size <= HEAD_SIZE ? head : await readFileCapped(filePath, SNIFF_CAP);
    const text = decodeText(sniffBuf);
    if (text !== undefined) {
      format = sniffText(text);
      confidence = 'sniff';
    }
  }

  return {
    path: filePath,
    name,
    size,
    format: format ?? null,
    category: categoryFor(format),
    confidence,
    warnings,
    media: undefined,
  };
}

function magicSpecificity(def: FormatDef, head: Buffer): number {
  let best = 0;
  for (const sig of def.magic ?? []) {
    if (matchesSignature(head, sig) && sig.bytes.length > best) best = sig.bytes.length;
  }
  return best;
}
