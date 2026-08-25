/**
 * `data:structured` — converts among JSON, JSON5, JSON Lines, YAML, TOML,
 * XML, INI, Java properties and property lists. Every input is parsed to a
 * plain JS value in memory, then serialized straight to the target format
 * (a single hop, never forced through an intermediate file).
 *
 * Cost model: three fidelity tiers.
 *  - json/json5/jsonl/yaml/toml/xml: mutually expressive, retention ~1.0.
 *  - plist: typed and nestable but no `null`, dates/binary collapse to
 *    strings — retention 0.85.
 *  - ini/properties: flat `key=value` only, everything becomes a string,
 *    nesting beyond one level is dot-flattened — retention 0.5.
 * A pair's cost uses the lower tier of its two endpoints.
 */

import { promises as fs } from 'node:fs';
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
import { ALL_STRUCTURED_CODECS, STRUCTURED_FORMATS } from './codecs';
import { checkAbort, engineFailure, formatLabel } from './util';

const RETENTION_TIER: Record<string, number> = {
  json: 1,
  json5: 1,
  jsonl: 1,
  yaml: 1,
  toml: 1,
  xml: 1,
  plist: 0.85,
  ini: 0.5,
  properties: 0.5,
};

const STRUCTURE_TIER: Record<string, number> = {
  json: 1,
  json5: 1,
  jsonl: 1,
  yaml: 1,
  toml: 1,
  xml: 1,
  plist: 0.85,
  ini: 0.35,
  properties: 0.3,
};

function pairCost(from: FormatId, to: FormatId): EdgeCost {
  const retention = Math.min(RETENTION_TIER[from] ?? 0.5, RETENTION_TIER[to] ?? 0.5);
  const structure = Math.min(STRUCTURE_TIER[from] ?? 0.5, STRUCTURE_TIER[to] ?? 0.5);
  return { retention, effort: 2, structure };
}

async function convert(
  input: ConversionInput,
  output: ConversionOutput,
  _options: ConverterOptions,
  ctx: ConvertContext,
): Promise<ConvertResult> {
  checkAbort(ctx.signal);
  ctx.onProgress({ ratio: 0, message: 'Reading input' });

  const fromCodec = ALL_STRUCTURED_CODECS[input.format];
  const toCodec = ALL_STRUCTURED_CODECS[output.format];
  if (!fromCodec || !toCodec) {
    throw new ConversionError({
      code: 'E_UNSUPPORTED_FEATURE',
      userMessage: `Converting ${formatLabel(input.format)} to ${formatLabel(output.format)} isn't supported.`,
      retryable: false,
    });
  }

  const raw = (await input.readBuffer()).toString('utf8');
  checkAbort(ctx.signal);
  ctx.onProgress({ ratio: 0.4, message: 'Parsing' });

  const value = fromCodec.parse(raw);

  ctx.onProgress({ ratio: 0.7, message: 'Serializing' });
  let text: string;
  try {
    text = toCodec.stringify(value);
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw engineFailure(output.format, err);
  }

  checkAbort(ctx.signal);
  const withTrailingNewline = text.endsWith('\n') ? text : `${text}\n`;
  await fs.writeFile(output.path, withTrailingNewline, 'utf8');

  ctx.onProgress({ ratio: 1 });
  return { bytes: Buffer.byteLength(withTrailingNewline, 'utf8') };
}

export const structuredDataConverter: Converter = {
  id: 'data:structured',
  name: 'Structured Data',
  engine: 'pure-js',
  inputs: STRUCTURED_FORMATS,
  outputs: STRUCTURED_FORMATS,
  cost: pairCost,
  async availability() {
    return { available: true };
  },
  convert,
};
