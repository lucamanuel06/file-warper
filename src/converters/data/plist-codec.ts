/**
 * Apple XML property list codec.
 *
 * Parsing uses `fast-xml-parser`'s `preserveOrder` mode, because a `<dict>`
 * pairs up alternating `<key>` / value elements and only order-preserving
 * parsing keeps that pairing intact (grouping same-tag siblings, the
 * parser's default mode, would scramble which key belongs to which value).
 * Serializing is hand-written text generation — plist's tag vocabulary is
 * small and fixed, and writing it directly is simpler and more predictable
 * than driving it back through a generic XML builder.
 *
 * Supported plist types: string, integer, real, true/false, array, dict.
 * `<date>` and `<data>` (base64) are read back as their raw text content
 * (a string) rather than a JS Date/Buffer — documented as a known
 * simplification. JS `null`/`undefined` have no plist equivalent and
 * serialize as an empty `<string>`.
 */

import { XMLParser } from 'fast-xml-parser';
import { corruptInput, isPlainObject, unsupportedFeature } from './util';

interface OrderedNode {
  [tag: string]: unknown;
  ':@'?: Record<string, unknown>;
}

function tagOf(node: OrderedNode): string | undefined {
  return Object.keys(node).find((k) => k !== ':@');
}

function childrenOf(node: OrderedNode): OrderedNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const kids = node[tag];
  return Array.isArray(kids) ? (kids as OrderedNode[]) : [];
}

function textOf(node: OrderedNode): string {
  const kids = childrenOf(node);
  const textNode = kids.find((k) => '#text' in k);
  return textNode ? String((textNode as Record<string, unknown>)['#text']) : '';
}

function valueFromElement(node: OrderedNode): unknown {
  const tag = tagOf(node);
  switch (tag) {
    case 'string':
    case 'date':
    case 'data':
      return textOf(node);
    case 'integer': {
      const n = Number.parseInt(textOf(node), 10);
      if (Number.isNaN(n))
        throw corruptInput('plist', new Error(`bad <integer>: ${textOf(node)}`));
      return n;
    }
    case 'real': {
      const n = Number.parseFloat(textOf(node));
      if (Number.isNaN(n))
        throw corruptInput('plist', new Error(`bad <real>: ${textOf(node)}`));
      return n;
    }
    case 'true':
      return true;
    case 'false':
      return false;
    case 'array':
      return childrenOf(node).map(valueFromElement);
    case 'dict': {
      const kids = childrenOf(node);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < kids.length; i += 2) {
        const keyNode = kids[i];
        const valNode = kids[i + 1];
        if (!keyNode || tagOf(keyNode) !== 'key' || !valNode) {
          throw corruptInput(
            'plist',
            new Error('malformed <dict>: expected alternating <key>/value elements'),
          );
        }
        obj[textOf(keyNode)] = valueFromElement(valNode);
      }
      return obj;
    }
    default:
      throw corruptInput('plist', new Error(`unsupported plist tag <${tag ?? '?'}>`));
  }
}

export function parsePlist(text: string): unknown {
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false });
  let ordered: unknown;
  try {
    ordered = parser.parse(text);
  } catch (err) {
    throw corruptInput('plist', err);
  }
  if (!Array.isArray(ordered)) {
    throw corruptInput('plist', new Error('unexpected document structure'));
  }
  const plistNode = (ordered as OrderedNode[]).find((n) => tagOf(n) === 'plist');
  if (!plistNode) {
    throw corruptInput('plist', new Error('missing <plist> root element'));
  }
  const kids = childrenOf(plistNode);
  if (kids.length === 0) return null;
  const first = kids[0];
  if (!first) return null;
  return valueFromElement(first);
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function elementForValue(value: unknown, indent: string): string {
  if (value === null || value === undefined) {
    return `${indent}<string></string>`;
  }
  if (typeof value === 'string') {
    return `${indent}<string>${escapeXmlText(value)}</string>`;
  }
  if (typeof value === 'boolean') {
    return `${indent}<${value}/>`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `${indent}<integer>${value}</integer>`
      : `${indent}<real>${value}</real>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>`;
    const inner = value.map((v) => elementForValue(v, `${indent}  `)).join('\n');
    return `${indent}<array>\n${inner}\n${indent}</array>`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indent}<dict/>`;
    const inner = entries
      .map(
        ([k, v]) =>
          `${indent}  <key>${escapeXmlText(k)}</key>\n${elementForValue(v, `${indent}  `)}`,
      )
      .join('\n');
    return `${indent}<dict>\n${inner}\n${indent}</dict>`;
  }
  throw unsupportedFeature(
    `A ${typeof value} value can't be represented in a property list.`,
  );
}

export function stringifyPlist(value: unknown): string {
  const body = elementForValue(value, '');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    body,
    '</plist>',
  ].join('\n');
}
