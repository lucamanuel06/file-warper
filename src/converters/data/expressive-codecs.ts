/**
 * Codecs for the mutually-expressive cluster: JSON, JSON5, YAML, TOML, XML,
 * JSON Lines. Each parses its text into a plain JS value and serializes a
 * plain JS value back into text, so any pair in the cluster converts
 * through this shared in-memory shape without a forced JSON file hop.
 */

import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import JSON5 from 'json5';
import { parse as parseTomlText, stringify as stringifyTomlText } from 'smol-toml';
import { parse as parseYamlText, stringify as stringifyYamlText } from 'yaml';
import { corruptInput, isPlainObject, unsupportedFeature } from './util';

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw corruptInput('json', err);
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function parseJson5(text: string): unknown {
  try {
    return JSON5.parse(text);
  } catch (err) {
    throw corruptInput('json5', err);
  }
}

export function stringifyJson5(value: unknown): string {
  return JSON5.stringify(value, null, 2);
}

export function parseYaml(text: string): unknown {
  try {
    return parseYamlText(text);
  } catch (err) {
    throw corruptInput('yaml', err);
  }
}

export function stringifyYaml(value: unknown): string {
  return stringifyYamlText(value);
}

export function parseToml(text: string): unknown {
  try {
    return parseTomlText(text);
  } catch (err) {
    throw corruptInput('toml', err);
  }
}

export function stringifyToml(value: unknown): string {
  if (!isPlainObject(value)) {
    throw unsupportedFeature(
      "TOML files must have a table at the top level, not a list or plain value — this data can't become TOML as-is.",
      'smol-toml only accepts a plain object at the top level.',
    );
  }
  try {
    return stringifyTomlText(value);
  } catch (err) {
    throw corruptInput('toml', err);
  }
}

export function parseJsonl(text: string): unknown {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
  try {
    return lines.map((line) => JSON.parse(line));
  } catch (err) {
    throw corruptInput('jsonl', err);
  }
}

export function stringifyJsonl(value: unknown): string {
  if (!Array.isArray(value)) {
    throw unsupportedFeature(
      "JSON Lines needs a top-level list of records — this data isn't a list.",
      'JSON Lines serialization requires an array at the top level.',
    );
  }
  return value.map((item) => JSON.stringify(item)).join('\n');
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/**
 * XML convention: the document root is always a synthetic `<root>` element
 * wrapping a single `<value>` child, so arbitrary JSON-shaped values
 * (arrays, primitives, objects) all round-trip through a valid single-root
 * XML document. Parsing arbitrary real-world XML (not produced by us) that
 * doesn't follow this convention still works: the outer root element's tag
 * name is discarded and its children are returned as-is.
 */
export function parseXml(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(text);
  } catch (err) {
    throw corruptInput('xml', err);
  }
  if (!isPlainObject(parsed)) throw corruptInput('xml', new Error('empty document'));
  const keys = Object.keys(parsed);
  const rootKey = keys[0];
  if (!rootKey) throw corruptInput('xml', new Error('missing root element'));
  const root = parsed[rootKey];
  if (isPlainObject(root)) {
    const rootKeys = Object.keys(root);
    if (rootKeys.length === 1 && rootKeys[0] === 'value') {
      return root.value;
    }
  }
  return root ?? null;
}

export function stringifyXml(value: unknown): string {
  return xmlBuilder.build({ root: { value } });
}
