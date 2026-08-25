/**
 * Hand-rolled Java `.properties` parser/serializer. No installed library
 * covers this format.
 *
 * `.properties` is always a flat string->string map — there is no section
 * concept like INI's. Parsing yields a flat object keyed by whatever text
 * preceded the separator (commonly dot-joined, e.g. `db.host`, but that is
 * just a convention baked into the key string, not real nesting). Nested
 * plain objects are flattened with dot-joined keys on the way out, because
 * `.properties` cannot express structure at all.
 */

import { flattenToPairs, isPlainObject, scalarToText, unsupportedFeature } from './util';

function findSeparator(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (ch === '=' || ch === ':') return i;
  }
  return -1;
}

function unescapeProperty(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === 'n') {
        out += '\n';
      } else if (next === 't') {
        out += '\t';
      } else {
        out += next;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function escapeKey(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/[=: ]/g, (m) => `\\${m}`);
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;

    const sep = findSeparator(line);
    if (sep === -1) {
      result[unescapeProperty(line)] = '';
      continue;
    }
    const key = unescapeProperty(line.slice(0, sep).trim());
    const value = unescapeProperty(line.slice(sep + 1).trim());
    result[key] = value;
  }

  return result;
}

export function stringifyProperties(value: unknown): string {
  if (!isPlainObject(value)) {
    throw unsupportedFeature(
      "This data isn't a flat key/value map, so it can't become a .properties file.",
      'Properties serialization requires a plain object at the top level.',
    );
  }

  return flattenToPairs(value)
    .map(([key, v]) => `${escapeKey(key)}=${escapeValue(scalarToText(v))}`)
    .join('\n');
}
