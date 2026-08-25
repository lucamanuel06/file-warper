import type { Cue } from './cue';
import { formatDotTimestamp, parseTimestamp } from './cue';

/**
 * Minimal hand-written TTML reader/writer — no XML dependency is installed,
 * so this only understands the subset File Warper emits and the common
 * subset other tools emit: `<tt><body><div><p begin=".." end="..">text</p>
 * ...`. `<br/>` becomes a newline; nested inline markup (<span>, styling
 * attributes) is stripped down to its text content. This is not a general
 * TTML/DFXP parser (no timing inheritance, no styling regions).
 */

const P_TAG = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
const ATTR = (name: string): RegExp => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');

/** `HH:MM:SS.mmm` or a bare seconds form like `12.5s` -> milliseconds. */
function parseTtmlTime(raw: string): number {
  const trimmed = raw.trim();
  const secondsForm = /^(\d+(?:\.\d+)?)s$/.exec(trimmed);
  if (secondsForm) {
    const [, secs] = secondsForm as unknown as [string, string];
    return Math.round(Number(secs) * 1000);
  }
  return parseTimestamp(trimmed);
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXmlEntities(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractText(innerXml: string): string {
  const withBreaks = innerXml.replace(/<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return decodeXmlEntities(stripped).trim();
}

/** Parse a TTML document into cues. */
export function parseTtml(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const match of source.matchAll(P_TAG)) {
    const [, attrs, inner] = match as unknown as [string, string, string];
    const beginMatch = ATTR('begin').exec(attrs);
    const endMatch = ATTR('end').exec(attrs);
    if (!beginMatch || !endMatch) continue;
    cues.push({
      start: parseTtmlTime(beginMatch[1] ?? ''),
      end: parseTtmlTime(endMatch[1] ?? ''),
      text: extractText(inner),
    });
  }
  return cues;
}

/** Serialize cues to a well-formed TTML document. */
export function serializeTtml(cues: readonly Cue[]): string {
  const paragraphs = cues
    .map((cue) => {
      const text = encodeXmlEntities(cue.text).replace(/\n/g, '<br/>');
      return `      <p begin="${formatDotTimestamp(cue.start)}" end="${formatDotTimestamp(cue.end)}">${text}</p>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml">',
    '  <body>',
    '    <div>',
    paragraphs,
    '    </div>',
    '  </body>',
    '</tt>',
    '',
  ].join('\n');
}
