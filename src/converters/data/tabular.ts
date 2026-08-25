/**
 * `data:tabular` — CSV/TSV against the structured-data formats. Separate
 * from `data:structured` because CSV/TSV only make sense for a flat array
 * of flat row-objects, never for arbitrary nested values.
 *
 * CSV/TSV -> other: rows become an array of objects keyed by the header
 * row (papaparse `header: true`).
 * other -> CSV/TSV: the source value must already be a flat array of flat
 * objects, unless `options.flatten` is on, in which case nested keys are
 * joined with `.` (e.g. `{a:{b:1}}` -> column `a.b`).
 *
 * TOML is the one target format that cannot hold a top-level array (it
 * requires a table at the root), so rows serialize there wrapped as
 * `{ rows: [...] }`, and the same shape is unwrapped when TOML is the
 * source — documented as a TOML-specific accommodation, not a general
 * "find the array" search.
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
import Papa from 'papaparse';
import { ALL_STRUCTURED_CODECS } from './codecs';
import {
  checkAbort,
  engineFailure,
  flattenToPairs,
  isPlainObject,
  scalarToText,
} from './util';

const TABULAR_FORMATS = ['csv', 'tsv'] as const;
type TabularFormat = (typeof TABULAR_FORMATS)[number];

const STRUCTURED_TARGETS = [
  'json',
  'json5',
  'jsonl',
  'yaml',
  'toml',
  'xml',
  'plist',
] as const;

function isTabular(format: FormatId): format is TabularFormat {
  return format === 'csv' || format === 'tsv';
}

function delimiterFor(format: TabularFormat): string {
  return format === 'tsv' ? '\t' : ',';
}

function notFlatList(): ConversionError {
  return new ConversionError({
    code: 'E_UNSUPPORTED_FEATURE',
    userMessage:
      'This data isn\'t a flat list of records, so it can\'t become a spreadsheet without flattening nested keys — turn on "Flatten nested keys" and try again.',
    retryable: false,
  });
}

function isFlatRow(row: Record<string, unknown>): boolean {
  return Object.values(row).every((v) => !isPlainObject(v) && !Array.isArray(v));
}

function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of flattenToPairs(row)) {
    flat[key] = Array.isArray(value) ? scalarToText(value) : value;
  }
  return flat;
}

function parseTabularText(
  text: string,
  format: TabularFormat,
): Record<string, unknown>[] {
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    delimiter: delimiterFor(format),
  });
  if (result.errors.length > 0) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: `This file isn't valid ${format.toUpperCase()} — it couldn't be parsed.`,
      detail: result.errors.map((e) => e.message).join('; '),
      retryable: false,
    });
  }
  return result.data;
}

function stringifyTabularText(
  rows: Record<string, unknown>[],
  format: TabularFormat,
): string {
  return Papa.unparse(rows, { delimiter: delimiterFor(format) });
}

/** Extracts the row array from a value already parsed from a non-tabular source. */
function extractRecordArray(
  format: FormatId,
  value: unknown,
  flatten: boolean,
): Record<string, unknown>[] {
  let candidate = value;
  if (format === 'toml' && !Array.isArray(candidate) && isPlainObject(candidate)) {
    const arrayProps = Object.entries(candidate).filter(([, v]) => Array.isArray(v));
    if (arrayProps.length === 1 && arrayProps[0]) candidate = arrayProps[0][1];
  }
  if (!Array.isArray(candidate) || !candidate.every(isPlainObject)) {
    throw notFlatList();
  }
  const rows = candidate as Record<string, unknown>[];
  if (rows.every(isFlatRow)) return rows;
  if (!flatten) throw notFlatList();
  return rows.map(flattenRow);
}

function rowsToValue(format: FormatId, rows: Record<string, unknown>[]): unknown {
  return format === 'toml' ? { rows } : rows;
}

function pairCost(from: FormatId, to: FormatId): EdgeCost {
  if (isTabular(from) && isTabular(to)) {
    return { retention: 0.95, effort: 1, structure: 1 };
  }
  return { retention: 0.75, effort: 2, structure: 0.6 };
}

async function convert(
  input: ConversionInput,
  output: ConversionOutput,
  options: ConverterOptions,
  ctx: ConvertContext,
): Promise<ConvertResult> {
  checkAbort(ctx.signal);
  const flatten = options.flatten === true;
  ctx.onProgress({ ratio: 0, message: 'Reading input' });

  const raw = (await input.readBuffer()).toString('utf8');
  checkAbort(ctx.signal);
  ctx.onProgress({ ratio: 0.4, message: 'Parsing' });

  let rows: Record<string, unknown>[];
  if (isTabular(input.format)) {
    rows = parseTabularText(raw, input.format);
  } else {
    const codec = ALL_STRUCTURED_CODECS[input.format];
    if (!codec) {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: `Reading ${input.format} isn't supported here.`,
        retryable: false,
      });
    }
    const value = codec.parse(raw);
    rows = extractRecordArray(input.format, value, flatten);
  }

  ctx.onProgress({ ratio: 0.7, message: 'Writing output' });
  let text: string;
  if (isTabular(output.format)) {
    text = stringifyTabularText(rows, output.format);
  } else {
    const codec = ALL_STRUCTURED_CODECS[output.format];
    if (!codec) {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: `Writing ${output.format} isn't supported here.`,
        retryable: false,
      });
    }
    try {
      text = codec.stringify(rowsToValue(output.format, rows));
    } catch (err) {
      if (err instanceof ConversionError) throw err;
      throw engineFailure(output.format, err);
    }
  }

  checkAbort(ctx.signal);
  // CSV/TSV text keeps papaparse's own line-ending convention as-is (forcing
  // a bare '\n' after its '\r\n' rows would get swallowed into the last
  // field on re-parse); structured formats get a plain trailing newline.
  const finalText = isTabular(output.format)
    ? text
    : text.endsWith('\n')
      ? text
      : `${text}\n`;
  await fs.writeFile(output.path, finalText, 'utf8');

  ctx.onProgress({ ratio: 1 });
  return { bytes: Buffer.byteLength(finalText, 'utf8') };
}

export const tabularDataConverter: Converter = {
  id: 'data:tabular',
  name: 'Tabular Data',
  engine: 'pure-js',
  inputs: [...TABULAR_FORMATS, ...STRUCTURED_TARGETS],
  outputs: [...TABULAR_FORMATS, ...STRUCTURED_TARGETS],
  supports(from, to) {
    return isTabular(from) || isTabular(to);
  },
  cost: pairCost,
  async availability() {
    return { available: true };
  },
  optionsSchema: {
    fields: [
      { key: 'flatten', kind: 'toggle', label: 'Flatten nested keys', default: false },
    ],
  },
  defaultOptions: { flatten: false },
  convert,
};
