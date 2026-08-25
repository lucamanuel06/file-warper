/**
 * Registry mapping a data FormatId to its parse/stringify pair. Shared by
 * both `data:structured` and `data:tabular` so the two converters agree on
 * exactly what each format means.
 */

import {
  parseJson,
  parseJson5,
  parseJsonl,
  parseToml,
  parseXml,
  parseYaml,
  stringifyJson,
  stringifyJson5,
  stringifyJsonl,
  stringifyToml,
  stringifyXml,
  stringifyYaml,
} from './expressive-codecs';
import { parseIni, stringifyIni } from './ini-codec';
import { parsePlist, stringifyPlist } from './plist-codec';
import { parseProperties, stringifyProperties } from './properties-codec';

export interface DataCodec {
  parse(text: string): unknown;
  stringify(value: unknown): string;
}

/** The mutually-expressive cluster: near-lossless for arbitrary JSON-shaped values. */
export const EXPRESSIVE_CODECS: Record<string, DataCodec> = {
  json: { parse: parseJson, stringify: stringifyJson },
  json5: { parse: parseJson5, stringify: stringifyJson5 },
  jsonl: { parse: parseJsonl, stringify: stringifyJsonl },
  yaml: { parse: parseYaml, stringify: stringifyYaml },
  toml: { parse: parseToml, stringify: stringifyToml },
  xml: { parse: parseXml, stringify: stringifyXml },
};

/** Typed but somewhat lossy: no `null`, dates/binary collapse to strings. */
export const PLIST_CODEC: Record<string, DataCodec> = {
  plist: { parse: parsePlist, stringify: stringifyPlist },
};

/** Flat `key=value` only: types and structure beyond one level are lost. */
export const FLAT_CODECS: Record<string, DataCodec> = {
  ini: { parse: parseIni, stringify: stringifyIni },
  properties: { parse: parseProperties, stringify: stringifyProperties },
};

export const ALL_STRUCTURED_CODECS: Record<string, DataCodec> = {
  ...EXPRESSIVE_CODECS,
  ...PLIST_CODEC,
  ...FLAT_CODECS,
};

export const STRUCTURED_FORMATS: readonly string[] = Object.keys(ALL_STRUCTURED_CODECS);
