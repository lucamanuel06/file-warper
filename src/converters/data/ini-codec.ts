/**
 * Hand-rolled INI parser/serializer. No installed library covers INI.
 *
 * Shape convention (documented in the data converter's report): parsing
 * yields a plain object where un-sectioned `key=value` lines land at the
 * top level and each `[section]` becomes one nested object one level deep.
 * INI has no native type system, so every parsed value is a string.
 * Serializing accepts any plain object: a top-level key whose value is
 * itself a plain object becomes a `[section]`; anything nested deeper than
 * that is flattened with dot-joined keys, because INI cannot express more
 * than one level of structure.
 */

import { isPlainObject, scalarToText, unsupportedFeature } from './util';

function stripIniQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseIni(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: Record<string, unknown> | null = null;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;

    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1]?.trim() ?? '';
      const section: Record<string, unknown> = {};
      result[name] = section;
      currentSection = section;
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = stripIniQuotes(line.slice(eq + 1).trim());
    const target = currentSection ?? result;
    target[key] = value;
  }

  return result;
}

function flattenSectionBody(value: unknown, prefix = ''): string[] {
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, v]) =>
      flattenSectionBody(v, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [`${prefix} = ${scalarToText(value)}`];
}

export function stringifyIni(value: unknown): string {
  if (!isPlainObject(value)) {
    throw unsupportedFeature(
      "This data isn't a section/key structure, so it can't become an INI file.",
      'INI serialization requires a plain object at the top level.',
    );
  }

  const rootLines: string[] = [];
  const sections: Array<[string, string[]]> = [];

  for (const [key, val] of Object.entries(value)) {
    if (isPlainObject(val)) {
      sections.push([key, flattenSectionBody(val)]);
    } else {
      rootLines.push(`${key} = ${scalarToText(val)}`);
    }
  }

  const parts = [...rootLines];
  for (const [name, lines] of sections) {
    if (parts.length > 0) parts.push('');
    parts.push(`[${name}]`, ...lines);
  }
  return parts.join('\n');
}
